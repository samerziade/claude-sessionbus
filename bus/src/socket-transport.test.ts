import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFrameDecoder, encodeFrame, type Frame } from '../../broker/src/protocol.ts'
import { type BrokerServer, startBroker } from '../../broker/src/server.ts'
import type { ChannelMessage } from './message.ts'
import { createSocketTransport } from './socket-transport.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c()
})

function tempSocket(): string {
	const dir = mkdtempSync(join(tmpdir(), 'bkr-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	return join(dir, 's')
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now()
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
		await new Promise((r) => setTimeout(r, 20))
	}
}

function msg(id: string, to: string): ChannelMessage {
	return {
		id,
		from: { sessionId: 'from', name: 'from', role: 'none' },
		to: { kind: 'session', value: to },
		text: id,
		createdAt: 0
	}
}

describe('socket transport', () => {
	it('delivers a message between two connected sessions', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const a = createSocketTransport({ socketPath })
		const b = createSocketTransport({ socketPath })
		const got: ChannelMessage[] = []
		cleanups.push(a.watch('A', () => {}))
		cleanups.push(b.watch('B', (m) => got.push(m)))
		await waitFor(() => server.connectedCount() === 2)

		a.send('B', msg('m1', 'B'))
		await waitFor(() => got.length === 1)
		expect(got[0]).toEqual(msg('m1', 'B'))
	})

	it('queues for an offline session and flushes when it connects', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const a = createSocketTransport({ socketPath })
		cleanups.push(a.watch('A', () => {}))
		await waitFor(() => server.connectedCount() === 1)
		a.send('C', msg('m1', 'C')) // C not connected yet

		const c = createSocketTransport({ socketPath })
		const got: ChannelMessage[] = []
		cleanups.push(c.watch('C', (m) => got.push(m)))
		await waitFor(() => got.length === 1)
		expect(got[0]).toEqual(msg('m1', 'C'))
	})

	it('buffers outbound sent before watch() and flushes after connect', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const b = createSocketTransport({ socketPath })
		const got: ChannelMessage[] = []
		cleanups.push(b.watch('B', (m) => got.push(m)))
		await waitFor(() => server.connectedCount() === 1)

		const d = createSocketTransport({ socketPath })
		d.send('B', msg('m1', 'B')) // sent BEFORE d.watch() -> buffered
		cleanups.push(d.watch('D', () => {}))
		await waitFor(() => got.length === 1)
		expect(got[0]).toEqual(msg('m1', 'B'))
	})

	it('reconnects and re-registers after the broker restarts', async () => {
		const socketPath = tempSocket()
		let server: BrokerServer = await startBroker({ socketPath })

		const a = createSocketTransport({ socketPath, initialBackoffMs: 50 })
		const gotA: ChannelMessage[] = []
		cleanups.push(a.watch('A', (m) => gotA.push(m)))
		await waitFor(() => server.connectedCount() === 1)

		await server.close()
		server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const e = createSocketTransport({ socketPath })
		cleanups.push(e.watch('E', () => {}))
		await waitFor(() => server.connectedCount() === 2) // A reconnected + E

		e.send('A', msg('m1', 'A'))
		await waitFor(() => gotA.length === 1)
		expect(gotA[0]).toEqual(msg('m1', 'A'))
	})
})

describe('rekey (identity settling after --resume)', () => {
	it('receives on the corrected id after re-keying', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const pm = createSocketTransport({ socketPath })
		const worker = createSocketTransport({ socketPath })
		const got: ChannelMessage[] = []
		// The bus subscribes with whatever the registry held at startup: the throwaway id.
		cleanups.push(pm.watch('throwaway', (m) => got.push(m)))
		cleanups.push(worker.watch('worker', () => {}))
		await waitFor(() => server.connectedCount() === 2)

		pm.rekey('real') // the registry rewrite landed
		await waitFor(() => server.connectedCount() === 2)

		// Peers discover us by our beacon, which carries the corrected id.
		worker.send('real', msg('m1', 'real'))
		await waitFor(() => got.length === 1)
		expect(got[0].id).toBe('m1')
	})

	it('re-keying before the socket connects registers only the corrected id', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const pm = createSocketTransport({ socketPath })
		const worker = createSocketTransport({ socketPath })
		const got: ChannelMessage[] = []
		cleanups.push(pm.watch('throwaway', (m) => got.push(m)))
		pm.rekey('real') // beats the 'connect' event
		cleanups.push(worker.watch('worker', () => {}))
		await waitFor(() => server.connectedCount() === 2)

		worker.send('real', msg('m1', 'real'))
		await waitFor(() => got.length === 1)
		expect(got[0].id).toBe('m1')
	})

	it('collects messages peers sent to the corrected id while we were mis-registered', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const pm = createSocketTransport({ socketPath })
		const worker = createSocketTransport({ socketPath })
		const got: ChannelMessage[] = []
		cleanups.push(pm.watch('throwaway', (m) => got.push(m)))
		cleanups.push(worker.watch('worker', () => {}))
		await waitFor(() => server.connectedCount() === 2)

		worker.send('real', msg('early', 'real')) // broker queues it: nobody holds 'real' yet
		await new Promise((r) => setTimeout(r, 50))
		expect(got).toEqual([])

		pm.rekey('real')
		await waitFor(() => got.length === 1) // the queue flushes on register
		expect(got[0].id).toBe('early')
	})

	it('no longer answers to the discarded id', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })
		cleanups.push(() => server.close())

		const pm = createSocketTransport({ socketPath })
		const worker = createSocketTransport({ socketPath })
		const got: ChannelMessage[] = []
		cleanups.push(pm.watch('throwaway', (m) => got.push(m)))
		cleanups.push(worker.watch('worker', () => {}))
		await waitFor(() => server.connectedCount() === 2)

		pm.rekey('real')
		await waitFor(() => server.connectedCount() === 2)

		worker.send('throwaway', msg('ghost', 'throwaway'))
		worker.send('real', msg('m1', 'real'))
		await waitFor(() => got.length === 1)
		await new Promise((r) => setTimeout(r, 80)) // give a stray delivery time to show up
		expect(got.map((m) => m.id)).toEqual(['m1'])
	})

	it('keeps the corrected id across a reconnect', async () => {
		const socketPath = tempSocket()
		const server = await startBroker({ socketPath })

		const pm = createSocketTransport({ socketPath, initialBackoffMs: 20 })
		const got: ChannelMessage[] = []
		cleanups.push(pm.watch('throwaway', (m) => got.push(m)))
		await waitFor(() => server.connectedCount() === 1)
		pm.rekey('real')
		await new Promise((r) => setTimeout(r, 50))

		await server.close() // broker restarts under us
		const server2 = await startBroker({ socketPath })
		cleanups.push(() => server2.close())
		await waitFor(() => server2.connectedCount() === 1)

		const worker = createSocketTransport({ socketPath })
		cleanups.push(worker.watch('worker', () => {}))
		await waitFor(() => server2.connectedCount() === 2)
		worker.send('real', msg('after-reconnect', 'real'))
		await waitFor(() => got.length === 1)
		expect(got[0].id).toBe('after-reconnect')
	})
})

/** A bare listener that records the frames a client sends, with no broker behaviour at all. */
interface Capture {
	frames: Frame[]
	/** Answer a request frame the client sent; nothing is answered unless a test says so. */
	answer?: (frame: Frame) => Frame | undefined
	/** Push a frame to the connected client, for answering out of order. */
	send(frame: Frame): void
}

async function captureServer(socketPath: string): Promise<Capture> {
	const frames: Frame[] = []
	const open = new Set<Socket>()
	let connected: Socket | undefined
	const capture: Capture = {
		frames,
		send: (frame) => connected?.write(encodeFrame(frame))
	}
	const server = createServer((socket) => {
		open.add(socket)
		connected = socket
		socket.on('close', () => open.delete(socket))
		socket.setEncoding('utf8')
		const decode = createFrameDecoder()
		socket.on('data', (chunk: string) => {
			for (const frame of decode(chunk)) {
				frames.push(frame)
				const reply = capture.answer?.(frame)
				if (reply !== undefined) socket.write(encodeFrame(reply))
			}
		})
	})
	await new Promise<void>((resolve) => server.listen(socketPath, resolve))
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve())
				// close() waits for every live connection; nothing ends them on its own.
				for (const socket of open) socket.destroy()
			})
	)
	return capture
}

describe('register announcement', () => {
	it('carries the derived project and the current title', async () => {
		const socketPath = tempSocket()
		const capture = await captureServer(socketPath)
		const transport = createSocketTransport({
			socketPath,
			announce: () => ({ project: 'sessionbus', title: '123 epic:42' })
		})

		cleanups.push(transport.watch('A', () => {}))
		await waitFor(() => capture.frames.length === 1)

		expect(capture.frames[0]).toEqual({
			type: 'register',
			sessionId: 'A',
			protocolVersion: 1,
			project: 'sessionbus',
			title: '123 epic:42'
		})
	})

	it("carries the project's readable name when the session announced one", async () => {
		const socketPath = tempSocket()
		const capture = await captureServer(socketPath)
		const transport = createSocketTransport({
			socketPath,
			announce: () => ({ project: 'owner-repo', projectName: 'owner/repo', title: 'notes' })
		})

		cleanups.push(transport.watch('A', () => {}))
		await waitFor(() => capture.frames.length === 1)

		expect(capture.frames[0]).toEqual({
			type: 'register',
			sessionId: 'A',
			protocolVersion: 1,
			project: 'owner-repo',
			projectName: 'owner/repo',
			title: 'notes'
		})
	})

	it('omits the readable name when the project has no owner half', async () => {
		const socketPath = tempSocket()
		const capture = await captureServer(socketPath)
		const transport = createSocketTransport({
			socketPath,
			announce: () => ({ project: 'scratch', projectName: undefined, title: 'notes' })
		})

		cleanups.push(transport.watch('A', () => {}))
		await waitFor(() => capture.frames.length === 1)

		// An absent name means "the slug is the only name there is", and an explicit
		// `undefined` must reach the broker as absence rather than as a field.
		expect(Object.hasOwn(capture.frames[0], 'projectName')).toBe(false)
	})

	it('omits the project when none could be derived', async () => {
		const socketPath = tempSocket()
		const capture = await captureServer(socketPath)
		const transport = createSocketTransport({
			socketPath,
			announce: () => ({ title: 'planning notes' })
		})

		cleanups.push(transport.watch('A', () => {}))
		await waitFor(() => capture.frames.length === 1)

		const frame = capture.frames[0]
		expect(Object.hasOwn(frame, 'project')).toBe(false)
		expect(frame).toEqual({
			type: 'register',
			sessionId: 'A',
			protocolVersion: 1,
			title: 'planning notes'
		})
	})

	it('re-reads the announcement on every register frame, never caching it', async () => {
		const socketPath = tempSocket()
		const capture = await captureServer(socketPath)
		let title = 'first title'
		const transport = createSocketTransport({
			socketPath,
			announce: () => ({ project: 'sessionbus', title })
		})

		cleanups.push(transport.watch('throwaway', () => {}))
		await waitFor(() => capture.frames.length === 1)
		title = 'corrected title'
		transport.rekey('real')
		await waitFor(() => capture.frames.length === 2)

		expect(capture.frames[1]).toEqual({
			type: 'register',
			sessionId: 'real',
			protocolVersion: 1,
			project: 'sessionbus',
			title: 'corrected title'
		})
	})

	it('still registers when nothing is announced at all', async () => {
		const socketPath = tempSocket()
		const capture = await captureServer(socketPath)
		const transport = createSocketTransport({ socketPath })

		cleanups.push(transport.watch('A', () => {}))
		await waitFor(() => capture.frames.length === 1)

		expect(capture.frames[0]).toEqual({ type: 'register', sessionId: 'A', protocolVersion: 1 })
	})
})

describe('history over the socket', () => {
	it('round-trips a history request and correlates its reply', async () => {
		const socketPath = tempSocket()
		const capture = await captureServer(socketPath)
		capture.answer = (frame) =>
			frame.type === 'history'
				? {
						type: 'history_reply',
						id: frame.id,
						result: { ok: true, room: '!epic:host', messages: [], more: false }
					}
				: undefined
		const transport = createSocketTransport({ socketPath })
		cleanups.push(transport.watch('A', () => {}))

		const result = await transport.history({ room: '!epic:host', limit: 5 })

		expect(result).toEqual({ ok: true, room: '!epic:host', messages: [], more: false })
		const sent = capture.frames.find((f) => f.type === 'history')
		expect(sent).toMatchObject({ type: 'history', query: { room: '!epic:host', limit: 5 } })
	})

	it('answers each of two outstanding requests with its own reply', async () => {
		const socketPath = tempSocket()
		const capture = await captureServer(socketPath)
		const transport = createSocketTransport({ socketPath })
		cleanups.push(transport.watch('A', () => {}))

		const first = transport.history({ room: '!one:host' })
		const second = transport.history({ room: '!two:host' })
		await waitFor(() => capture.frames.filter((f) => f.type === 'history').length === 2)

		// Answered in the opposite order: the correlation id pairs them, not arrival order.
		const asked = capture.frames.filter((f) => f.type === 'history')
		for (const frame of asked.slice().reverse()) {
			if (frame.type !== 'history') continue
			capture.send({
				type: 'history_reply',
				id: frame.id,
				result: { ok: true, room: frame.query.room ?? '', messages: [], more: false }
			})
		}

		expect(await first).toMatchObject({ ok: true, room: '!one:host' })
		expect(await second).toMatchObject({ ok: true, room: '!two:host' })
	})

	it('resolves as unavailable rather than hanging when no reply ever comes', async () => {
		const socketPath = tempSocket()
		await captureServer(socketPath)
		const transport = createSocketTransport({ socketPath, requestTimeoutMs: 40 })
		cleanups.push(transport.watch('A', () => {}))

		await expect(transport.history({})).resolves.toEqual({ ok: false, reason: 'unavailable' })
	})

	it('round-trips a Matrix-addressed reply and reports its destination', async () => {
		const socketPath = tempSocket()
		const capture = await captureServer(socketPath)
		capture.answer = (frame) =>
			frame.type === 'matrix_reply'
				? {
						type: 'matrix_reply_result',
						id: frame.id,
						result: { ok: true, room: '!epic:host', thread: 't_9f2a' }
					}
				: undefined
		const transport = createSocketTransport({ socketPath })
		cleanups.push(transport.watch('A', () => {}))

		const result = await transport.replyToHuman({ to: '@samer:host', text: 'on it' })

		expect(result).toEqual({ ok: true, room: '!epic:host', thread: 't_9f2a' })
		expect(capture.frames.find((f) => f.type === 'matrix_reply')).toMatchObject({
			request: { to: '@samer:host', text: 'on it' }
		})
	})

	it('resolves a Matrix reply as unavailable when the broker never answers', async () => {
		const socketPath = tempSocket()
		await captureServer(socketPath)
		const transport = createSocketTransport({ socketPath, requestTimeoutMs: 40 })
		cleanups.push(transport.watch('A', () => {}))

		await expect(transport.replyToHuman({ to: '@samer:host', text: 'on it' })).resolves.toEqual({
			ok: false,
			reason: 'unavailable'
		})
	})

	it('answers unavailable when there is no broker to ask at all', async () => {
		const transport = createSocketTransport({
			socketPath: join(tempSocket(), 'nothing-here'),
			requestTimeoutMs: 40
		})
		cleanups.push(transport.watch('A', () => {}))

		await expect(transport.history({})).resolves.toEqual({ ok: false, reason: 'unavailable' })
	})
})
