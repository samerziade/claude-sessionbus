import { describe, expect, it } from 'vitest'
import { createBrokerCore, type Conn } from './broker.ts'
import type { Frame } from './protocol.ts'
import type { ChannelMessage } from '../../bus/src/message.ts'

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
