import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChannelMessage } from '../../bus/src/message.ts'
import type { RegisteredSession } from './broker.ts'
import { createFrameDecoder, encodeFrame, type Frame, type RegisterMeta } from './protocol.ts'
import {
	type BrokerServer,
	handleServerError,
	type StartBrokerOptions,
	startBroker,
	UNAVAILABLE
} from './server.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c()
})

function tempSocket(): string {
	const dir = mkdtempSync(join(tmpdir(), 'bkr-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	return join(dir, 's')
}

function track(server: BrokerServer): BrokerServer {
	cleanups.push(() => server.close())
	return server
}

/** What a client announces on registering — the wire contract itself, never restated. */
type Announcement = RegisterMeta

/** Connect a client, register with `sessionId`, resolve once its welcome arrives. */
function registerClient(
	socketPath: string,
	sessionId: string,
	announce: Announcement = {}
): Promise<Socket> {
	return new Promise((resolve) => {
		const sock = connect(socketPath)
		cleanups.push(() => {
			sock.destroy()
		})
		sock.setEncoding('utf8')
		const decode = createFrameDecoder()
		sock.on('connect', () =>
			sock.write(encodeFrame({ type: 'register', sessionId, protocolVersion: 1, ...announce }))
		)
		sock.on('error', () => {}) // a deliberate client-side destroy raises 'error'; ignore it
		sock.on('data', (chunk: string) => {
			for (const _ of decode(chunk)) {
				resolve(sock)
				return
			}
		})
	})
}

/** Poll a predicate until true or the timeout elapses. */
function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now()
		const tick = () => {
			if (pred()) return resolve()
			if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timed out'))
			setTimeout(tick, 10)
		}
		tick()
	})
}

describe('broker server', () => {
	it('accepts a register and replies with a welcome frame', async () => {
		const socketPath = tempSocket()
		track(await startBroker({ socketPath }))
		const welcome = await new Promise<Frame>((resolve) => {
			const sock = connect(socketPath)
			sock.setEncoding('utf8')
			const decode = createFrameDecoder()
			sock.on('connect', () =>
				sock.write(encodeFrame({ type: 'register', sessionId: 'A', protocolVersion: 1 }))
			)
			sock.on('data', (chunk: string) => {
				for (const f of decode(chunk)) {
					sock.destroy()
					resolve(f)
				}
			})
		})
		expect(welcome).toEqual({ type: 'welcome', protocolVersion: 1 })
	})

	it('reclaims a stale socket file left by a dead predecessor', async () => {
		const socketPath = tempSocket()
		writeFileSync(socketPath, 'stale') // leftover file, nothing listening
		const server = track(await startBroker({ socketPath }))
		expect(server.connectedCount()).toBe(0)
	})

	it('rejects a second broker on the same live socket', async () => {
		const socketPath = tempSocket()
		track(await startBroker({ socketPath }))
		await expect(startBroker({ socketPath })).rejects.toThrow(/already running/)
	})

	it('drops a single erroring client without failing the whole broker', async () => {
		const socketPath = tempSocket()
		const fatals: Error[] = []
		const server = track(await startBroker({ socketPath, onFatal: (e) => fatals.push(e) }))
		const a = await registerClient(socketPath, 'A')
		await registerClient(socketPath, 'B')
		expect(server.connectedCount()).toBe(2)

		a.destroy(new Error('client boom'))
		await waitUntil(() => server.connectedCount() === 1)

		expect(fatals).toEqual([]) // a client failure is not a broker failure
		// broker still serves new clients
		await registerClient(socketPath, 'C')
		expect(server.connectedCount()).toBe(2)
	})

	it('does not treat stale-socket reclaim or a double-bind rejection as fatal', async () => {
		const socketPath = tempSocket()
		writeFileSync(socketPath, 'stale')
		const fatals: Error[] = []
		track(await startBroker({ socketPath, onFatal: (e) => fatals.push(e) }))
		await expect(startBroker({ socketPath, onFatal: (e) => fatals.push(e) })).rejects.toThrow(
			/already running/
		)
		expect(fatals).toEqual([])
	})
})

describe('handleServerError', () => {
	it('logs and invokes onFatal once with the error', () => {
		const logs: string[] = []
		const fatals: Error[] = []
		const err = new Error('listener boom')

		handleServerError(err, { log: (m) => logs.push(m), onFatal: (e) => fatals.push(e) })

		expect(fatals).toEqual([err])
		expect(logs.join('\n')).toContain('listener boom')
	})

	it('only logs when no onFatal is provided (embeddable default)', () => {
		const logs: string[] = []

		expect(() => handleServerError(new Error('x'), { log: (m) => logs.push(m) })).not.toThrow()

		expect(logs.join('\n')).toContain('x')
	})
})

describe('register announcements', () => {
	/** Collect a routed message by registering a second client and sending to the first. */
	function collect(sock: Socket, got: Frame[]): void {
		const decode = createFrameDecoder()
		sock.on('data', (chunk: string) => {
			for (const frame of decode(chunk)) got.push(frame)
		})
	}

	function message(id: string, to: string): ChannelMessage {
		return {
			id,
			from: { sessionId: 'from', name: 'from', role: 'none' },
			to: { kind: 'session', value: to },
			text: id,
			createdAt: 0
		}
	}

	it('acknowledges and counts a client that announces a project and a title', async () => {
		const socketPath = tempSocket()
		const seen: Array<{ sessionId: string; project?: string; title?: string }> = []
		const server = track(
			await startBroker({
				socketPath,
				onRegistered: (info) => {
					seen.push(info)
				}
			})
		)

		await registerClient(socketPath, 'A', { project: 'sessionbus', title: '123 epic:42' })

		expect(server.connectedCount()).toBe(1)
		await waitUntil(() => seen.length === 1)
		expect(seen).toEqual([{ sessionId: 'A', project: 'sessionbus', title: '123 epic:42' }])
	})

	it("hands the bridge the project's readable name, when the session announced one", async () => {
		const socketPath = tempSocket()
		const seen: RegisteredSession[] = []
		track(
			await startBroker({
				socketPath,
				onRegistered: (info) => {
					seen.push(info)
				}
			})
		)

		await registerClient(socketPath, 'A', {
			project: 'owner-repo',
			projectName: 'owner/repo',
			title: 'notes'
		})

		await waitUntil(() => seen.length === 1)
		// Only the session can know this: which dash of `owner-repo` was the owner's cannot be
		// recovered from the slug, so a name dropped here is a name the space can never carry.
		expect(seen[0].projectName).toBe('owner/repo')
	})

	it('acknowledges and delivers while provisioning never settles', async () => {
		const socketPath = tempSocket()
		const fatals: Error[] = []
		const server = track(
			await startBroker({
				socketPath,
				onFatal: (e) => fatals.push(e),
				onRegistered: () => new Promise<void>(() => {})
			})
		)

		const a = await registerClient(socketPath, 'A', { project: 'sessionbus', title: 'notes' })
		const got: Frame[] = []
		collect(a, got)
		const b = await registerClient(socketPath, 'B', { project: 'sessionbus', title: 'notes' })
		b.write(encodeFrame({ type: 'send', to: 'A', msg: message('m1', 'A') }))

		await waitUntil(() => got.length === 1)
		expect(got[0]).toEqual({ type: 'deliver', msg: message('m1', 'A') })
		expect(server.connectedCount()).toBe(2)
		expect(fatals).toEqual([])
	})

	it('stays bound and delivering when provisioning rejects', async () => {
		const socketPath = tempSocket()
		const fatals: Error[] = []
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', onUnhandled)
		cleanups.push(() => {
			process.off('unhandledRejection', onUnhandled)
		})
		const server = track(
			await startBroker({
				socketPath,
				onFatal: (e) => fatals.push(e),
				onRegistered: () => Promise.reject(new Error('homeserver unreachable'))
			})
		)

		const a = await registerClient(socketPath, 'A', { project: 'sessionbus', title: 'notes' })
		const got: Frame[] = []
		collect(a, got)
		const b = await registerClient(socketPath, 'B', { project: 'sessionbus', title: 'notes' })
		b.write(encodeFrame({ type: 'send', to: 'A', msg: message('m1', 'A') }))

		await waitUntil(() => got.length === 1)
		expect(server.connectedCount()).toBe(2)
		expect(fatals).toEqual([])
		expect(unhandled).toEqual([])
	})

	it('hands every routed message to the mirror', async () => {
		const socketPath = tempSocket()
		const mirrored: ChannelMessage[] = []
		track(
			await startBroker({
				socketPath,
				onRouted: (msg) => {
					mirrored.push(msg)
				}
			})
		)

		const a = await registerClient(socketPath, 'A', { project: 'sessionbus', title: 'notes' })
		const got: Frame[] = []
		collect(a, got)
		const b = await registerClient(socketPath, 'B', { project: 'sessionbus', title: 'notes' })
		b.write(encodeFrame({ type: 'send', to: 'A', msg: message('m1', 'A') }))

		await waitUntil(() => got.length === 1)
		await waitUntil(() => mirrored.length === 1)
		expect(mirrored[0]).toEqual(message('m1', 'A'))
	})

	// Both shapes a mirror can fail in, because they escape by different routes: a synchronous
	// throw becomes an uncaughtException, a rejected post an unhandledRejection, and the host
	// process turns either into a fatal exit. One listener cannot see both.
	for (const [shape, onRouted] of [
		[
			'throws',
			() => {
				throw new Error('homeserver unreachable')
			}
		],
		['rejects', () => Promise.reject(new Error('homeserver unreachable'))]
	] as const) {
		it(`keeps delivering locally when the mirror ${shape}, and never exits over it`, async () => {
			const socketPath = tempSocket()
			const fatals: Error[] = []
			const escaped: unknown[] = []
			const onEscape = (reason: unknown) => escaped.push(reason)
			process.on('unhandledRejection', onEscape)
			process.on('uncaughtException', onEscape)
			cleanups.push(() => {
				process.off('unhandledRejection', onEscape)
				process.off('uncaughtException', onEscape)
			})
			const server = track(
				await startBroker({
					socketPath,
					onFatal: (e) => fatals.push(e),
					onRouted
				})
			)

			const a = await registerClient(socketPath, 'A', { project: 'sessionbus', title: 'notes' })
			const got: Frame[] = []
			collect(a, got)
			const b = await registerClient(socketPath, 'B', { project: 'sessionbus', title: 'notes' })
			b.write(encodeFrame({ type: 'send', to: 'A', msg: message('m1', 'A') }))

			await waitUntil(() => got.length === 1)
			expect(got[0]).toEqual({ type: 'deliver', msg: message('m1', 'A') })
			expect(server.connectedCount()).toBe(2)
			expect(fatals).toEqual([])
			expect(escaped).toEqual([])
		})
	}
})

/** Collect every frame a registered client receives after its welcome. */
function collect(sock: Socket): Frame[] {
	const frames: Frame[] = []
	const decode = createFrameDecoder()
	sock.on('data', (chunk: string) => {
		for (const frame of decode(chunk)) frames.push(frame)
	})
	return frames
}

describe('bridge requests over the socket', () => {
	it('answers a history request from the bridge, attributed to the caller', async () => {
		const socketPath = tempSocket()
		const asked: { sessionId: string; room?: string }[] = []
		track(
			await startBroker({
				socketPath,
				onHistory: async (sessionId, query) => {
					asked.push({ sessionId, room: query.room })
					return { ok: true, room: '!epic:host', messages: [], more: false }
				}
			})
		)
		const sock = await registerClient(socketPath, 'A', { project: 'p', title: 't' })
		const frames = collect(sock)

		sock.write(encodeFrame({ type: 'history', id: 'q1', query: { room: '!epic:host' } }))
		await waitUntil(() => frames.length > 0)

		expect(asked).toEqual([{ sessionId: 'A', room: '!epic:host' }])
		expect(frames[0]).toEqual({
			type: 'history_reply',
			id: 'q1',
			result: { ok: true, room: '!epic:host', messages: [], more: false }
		})
	})

	it('answers unavailable when no bridge is wired', async () => {
		const socketPath = tempSocket()
		track(await startBroker({ socketPath }))
		const sock = await registerClient(socketPath, 'A')
		const frames = collect(sock)

		sock.write(encodeFrame({ type: 'history', id: 'q1', query: {} }))
		await waitUntil(() => frames.length > 0)

		expect(frames[0]).toEqual({
			type: 'history_reply',
			id: 'q1',
			result: { ok: false, reason: 'unavailable' }
		})
	})

	it('answers unavailable rather than dying when the bridge rejects', async () => {
		const socketPath = tempSocket()
		track(
			await startBroker({
				socketPath,
				onHistory: () => Promise.reject(new Error('homeserver unreachable'))
			})
		)
		const sock = await registerClient(socketPath, 'A')
		const frames = collect(sock)

		sock.write(encodeFrame({ type: 'history', id: 'q1', query: {} }))
		await waitUntil(() => frames.length > 0)

		expect(frames[0]).toMatchObject({ result: { ok: false, reason: 'unavailable' } })
	})

	it('answers a Matrix reply request and reports its destination', async () => {
		const socketPath = tempSocket()
		const asked: string[] = []
		track(
			await startBroker({
				socketPath,
				onMatrixReply: async (sessionId, req) => {
					asked.push(`${sessionId}:${req.to}`)
					return { ok: true, room: '!epic:host', thread: 't_9f2a' }
				}
			})
		)
		const sock = await registerClient(socketPath, 'A')
		const frames = collect(sock)

		sock.write(
			encodeFrame({
				type: 'matrix_reply',
				id: 'q2',
				request: { to: '@samer:host', text: 'on it' }
			})
		)
		await waitUntil(() => frames.length > 0)

		expect(asked).toEqual(['A:@samer:host'])
		expect(frames[0]).toEqual({
			type: 'matrix_reply_result',
			id: 'q2',
			result: { ok: true, room: '!epic:host', thread: 't_9f2a' }
		})
	})

	it('keeps delivering messages while a bridge request is outstanding', async () => {
		const socketPath = tempSocket()
		let release: (() => void) | undefined
		track(
			await startBroker({
				socketPath,
				onHistory: () =>
					new Promise((resolve) => {
						release = () => resolve({ ok: false, reason: 'not_found' })
					})
			})
		)
		const a = await registerClient(socketPath, 'A')
		const b = await registerClient(socketPath, 'B')
		const frames = collect(b)

		a.write(encodeFrame({ type: 'history', id: 'q1', query: {} }))
		await waitUntil(() => release !== undefined)
		const msg: ChannelMessage = {
			id: 'm1',
			from: { sessionId: 'A', name: 'A', role: 'none' },
			to: { kind: 'session', value: 'B' },
			text: 'hello',
			createdAt: 0
		}
		a.write(encodeFrame({ type: 'send', to: 'B', msg }))

		await waitUntil(() => frames.some((f) => f.type === 'deliver'))
		release?.()
	})
})

describe('the core, exposed for the inbound relay', () => {
	it('routes through the same call a local send uses, to the identity’s current session', async () => {
		const socketPath = tempSocket()
		const server = track(await startBroker({ socketPath }))
		const sock = await registerClient(socketPath, 'A', { project: 'proj', title: '1234 epic:42' })
		const frames = collect(sock)

		const to = server.sessionForIdentity('proj/1234 epic:42')
		expect(to).toBe('A')
		server.route(to ?? '', {
			id: 'w1',
			from: {
				sessionId: '@samer:host',
				userId: '@samer:host',
				name: 'Samer Z',
				role: 'none',
				origin: 'human'
			},
			to: { kind: 'session', value: 'A' },
			text: '[14:02] Samer Z: ship it',
			createdAt: 0,
			relay: { room: '!epic:host', unread: 1, omitted: 0, since: 's-1' }
		})

		await waitUntil(() => frames.some((f) => f.type === 'deliver'))
	})

	it('knows nothing of an identity nobody has registered', async () => {
		const socketPath = tempSocket()
		const server = track(await startBroker({ socketPath }))

		expect(server.sessionForIdentity('proj/nobody')).toBeUndefined()
	})
})

describe('a bridge that is never constructed', () => {
	/**
	 * How the entrypoint wires the bridge in: the socket is bound first and every hook reads a
	 * bridge that is filled in afterwards — or never, when the token command never returns.
	 * Typed off `StartBrokerOptions` rather than restated, so the two cannot drift.
	 */
	type LateBridge = Pick<StartBrokerOptions, 'onRegistered' | 'onRouted' | 'onHistory'>

	function wake(id: string, to: string): ChannelMessage {
		return {
			id,
			from: { sessionId: 'from', name: 'from', role: 'none' },
			to: { kind: 'session', value: to },
			text: id,
			createdAt: 0
		}
	}

	it('leaves the socket bound and two sessions messaging each other', async () => {
		const socketPath = tempSocket()
		const fatals: Error[] = []
		let bridge: LateBridge | undefined
		const server = track(
			await startBroker({
				socketPath,
				onFatal: (e) => fatals.push(e),
				onRegistered: (session) => bridge?.onRegistered?.(session),
				onRouted: (msg) => bridge?.onRouted?.(msg),
				onHistory: (sessionId, query) =>
					bridge?.onHistory?.(sessionId, query) ?? Promise.resolve(UNAVAILABLE)
			})
		)

		expect(existsSync(socketPath)).toBe(true)
		const a = await registerClient(socketPath, 'A', { project: 'sessionbus', title: 'notes' })
		const frames = collect(a)
		const b = await registerClient(socketPath, 'B', { project: 'sessionbus', title: 'notes' })
		b.write(encodeFrame({ type: 'send', to: 'A', msg: wake('m1', 'A') }))

		await waitUntil(() => frames.length === 1)
		expect(frames[0]).toEqual({ type: 'deliver', msg: wake('m1', 'A') })
		expect(server.connectedCount()).toBe(2)
		expect(bridge).toBeUndefined() // nothing about the bridge was ever built
		expect(fatals).toEqual([])
	})

	it('reaches a bridge attached after the broker is already serving', async () => {
		const socketPath = tempSocket()
		let bridge: LateBridge | undefined
		track(
			await startBroker({
				socketPath,
				onRegistered: (session) => bridge?.onRegistered?.(session)
			})
		)

		await registerClient(socketPath, 'early', { project: 'sessionbus', title: 'notes' })
		const seen: string[] = []
		bridge = {
			onRegistered: (session) => {
				seen.push(session.sessionId)
			}
		}
		await registerClient(socketPath, 'late', { project: 'sessionbus', title: 'notes' })

		await waitUntil(() => seen.length === 1)
		expect(seen).toEqual(['late']) // the hook is read per registration, never snapshotted
	})
})
