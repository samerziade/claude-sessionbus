import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeFrame, createFrameDecoder, type Frame } from './protocol.ts'
import { startBroker, type BrokerServer } from './server.ts'

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
})
