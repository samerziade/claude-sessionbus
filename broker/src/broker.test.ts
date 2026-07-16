import { describe, expect, it } from 'vitest'
import type { ChannelMessage } from '../../bus/src/message.ts'
import { type Conn, createBrokerCore } from './broker.ts'
import type { Frame } from './protocol.ts'

function fakeConn(): Conn & { sent: Frame[] } {
	const sent: Frame[] = []
	return { sent, send: (f) => sent.push(f), close: () => {} }
}

function msg(id: string): ChannelMessage {
	return {
		id,
		from: { sessionId: 'x', name: 'x', role: 'none' },
		to: { kind: 'session', value: 'y' },
		text: id,
		createdAt: 0
	}
}

describe('broker core', () => {
	it('delivers to a connected recipient', () => {
		const core = createBrokerCore()
		const b = fakeConn()
		core.register(b, 'B')
		core.route('B', msg('m1'))
		expect(b.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
	})

	it('queues for an offline recipient and flushes on register (in order)', () => {
		const core = createBrokerCore()
		core.route('B', msg('m1'))
		core.route('B', msg('m2'))
		const b = fakeConn()
		core.register(b, 'B')
		expect(b.sent).toEqual([
			{ type: 'deliver', msg: msg('m1') },
			{ type: 'deliver', msg: msg('m2') }
		])
	})

	it('duplicate register replaces the connection; routing goes to the newest', () => {
		const core = createBrokerCore()
		const b1 = fakeConn()
		const b2 = fakeConn()
		core.register(b1, 'B')
		core.register(b2, 'B')
		core.route('B', msg('m1'))
		expect(b1.sent).toEqual([])
		expect(b2.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
	})

	it('disconnect drops the mapping but keeps the queue', () => {
		const core = createBrokerCore()
		const b = fakeConn()
		core.register(b, 'B')
		core.disconnect(b)
		expect(core.connectedCount()).toBe(0)
		core.route('B', msg('m1')) // now offline -> queued
		const b2 = fakeConn()
		core.register(b2, 'B')
		expect(b2.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
	})

	it('a stale conn disconnecting does not clobber a newer conn', () => {
		const core = createBrokerCore()
		const b1 = fakeConn()
		const b2 = fakeConn()
		core.register(b1, 'B')
		core.register(b2, 'B')
		core.disconnect(b1) // b1 is stale; b2 is current
		expect(core.connectedCount()).toBe(1)
		core.route('B', msg('m1'))
		expect(b2.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
	})

	it('bounded queue drops the oldest on overflow', () => {
		const core = createBrokerCore({ maxQueuePerSession: 2 })
		core.route('B', msg('m1'))
		core.route('B', msg('m2'))
		core.route('B', msg('m3')) // overflow -> drop m1
		const b = fakeConn()
		core.register(b, 'B')
		expect(b.sent).toEqual([
			{ type: 'deliver', msg: msg('m2') },
			{ type: 'deliver', msg: msg('m3') }
		])
	})
})

describe('re-registration (identity settling after --resume)', () => {
	it('routes to the corrected id after a conn re-registers', () => {
		const core = createBrokerCore()
		const pm = fakeConn()
		core.register(pm, 'throwaway')
		core.register(pm, 'real') // registry rewrite landed; we correct our id

		core.route('real', msg('m1'))
		expect(pm.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
	})

	it('drops the stale binding so the old id no longer resolves to us', () => {
		const core = createBrokerCore()
		const pm = fakeConn()
		core.register(pm, 'throwaway')
		core.register(pm, 'real')

		expect(core.connectedCount()).toBe(1) // not 2: 'throwaway' must not linger

		// A message to the discarded id must queue for a future owner, not reach us.
		core.route('throwaway', msg('ghost'))
		expect(pm.sent).toEqual([])
	})

	it('flushes messages queued under the corrected id while we were mis-registered', () => {
		const core = createBrokerCore()
		const pm = fakeConn()
		core.register(pm, 'throwaway')
		core.route('real', msg('sent-while-misregistered')) // peers already address the beacon id
		expect(pm.sent).toEqual([])

		core.register(pm, 'real')
		expect(pm.sent).toEqual([{ type: 'deliver', msg: msg('sent-while-misregistered') }])
	})

	it('disconnect after a re-key leaves no route behind', () => {
		const core = createBrokerCore()
		const pm = fakeConn()
		core.register(pm, 'throwaway')
		core.register(pm, 'real')
		core.disconnect(pm)
		expect(core.connectedCount()).toBe(0)
	})

	it('does not disturb another session that legitimately owns the old id', () => {
		const core = createBrokerCore()
		const pm = fakeConn()
		const other = fakeConn()
		core.register(pm, 'shared')
		core.register(other, 'shared') // other takes over the id
		core.register(pm, 'real') // pm re-keys; must not evict other's binding

		core.route('shared', msg('m1'))
		expect(other.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
		expect(core.connectedCount()).toBe(2)
	})
})
