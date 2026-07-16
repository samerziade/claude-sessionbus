import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
