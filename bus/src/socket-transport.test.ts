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
