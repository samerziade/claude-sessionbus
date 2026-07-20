import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFrameDecoder, encodeFrame, type Frame } from './protocol.ts'
import { type BrokerServer, handleServerError, startBroker } from './server.ts'

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

/** Connect a client, register with `sessionId`, resolve once its welcome arrives. */
function registerClient(socketPath: string, sessionId: string): Promise<Socket> {
	return new Promise((resolve) => {
		const sock = connect(socketPath)
		cleanups.push(() => {
			sock.destroy()
		})
		sock.setEncoding('utf8')
		const decode = createFrameDecoder()
		sock.on('connect', () =>
			sock.write(encodeFrame({ type: 'register', sessionId, protocolVersion: 1 }))
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
