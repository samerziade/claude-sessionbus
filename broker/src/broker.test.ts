import { describe, expect, it } from 'vitest'
import type { ChannelMessage } from '../../bus/src/message.ts'
import { type Conn, createBrokerCore, workIdentity } from './broker.ts'
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

describe('identity map', () => {
	const IDENTITY = workIdentity({ project: 'sessionbus', title: '123 epic:42' }) ?? ''

	it('follows a session id corrected by a second registration', () => {
		const core = createBrokerCore()
		const conn = fakeConn()

		core.register(conn, 'throwaway', { project: 'sessionbus', title: '123 epic:42' })
		core.register(conn, 'real', { project: 'sessionbus', title: '123 epic:42' })

		expect(core.sessionForIdentity(IDENTITY)).toBe('real')
		expect(core.identityForSession('throwaway')).toBeUndefined()
	})

	it('gives one identity to the later of two sessions claiming it', () => {
		const core = createBrokerCore()

		core.register(fakeConn(), 'A', { project: 'sessionbus', title: '123 epic:42' })
		core.register(fakeConn(), 'B', { project: 'sessionbus', title: '123 epic:42' })

		expect(core.sessionForIdentity(IDENTITY)).toBe('B')
	})

	it('clears the mapping a disconnecting session owned', () => {
		const core = createBrokerCore()
		const conn = fakeConn()
		core.register(conn, 'A', { project: 'sessionbus', title: '123 epic:42' })

		core.disconnect(conn)

		expect(core.sessionForIdentity(IDENTITY)).toBeUndefined()
		expect(core.identityForSession('A')).toBeUndefined()
	})

	it('resolves an identity that never registered to nothing', () => {
		const core = createBrokerCore()

		expect(core.sessionForIdentity('never/seen')).toBeUndefined()
		expect(core.identityForSession('nobody')).toBeUndefined()
	})

	it('maps no identity for a registration that announces no project', () => {
		const core = createBrokerCore()
		const conn = fakeConn()

		core.register(conn, 'A', { title: '123 epic:42' })

		expect(core.identityForSession('A')).toBeUndefined()
		expect(workIdentity({ title: '123 epic:42' })).toBeUndefined()
	})
})

describe('registration hook', () => {
	it('fires with the announced project and title', () => {
		const seen: Array<{ sessionId: string; project?: string; title?: string }> = []
		const core = createBrokerCore({
			onRegistered: (info) => {
				seen.push(info)
			}
		})

		core.register(fakeConn(), 'A', { project: 'sessionbus', title: '123 epic:42' })

		expect(seen).toEqual([{ sessionId: 'A', project: 'sessionbus', title: '123 epic:42' }])
	})

	it('does not fire for a registration with no project', () => {
		const seen: unknown[] = []
		const core = createBrokerCore({
			onRegistered: (info) => {
				seen.push(info)
			}
		})

		core.register(fakeConn(), 'A', { title: 'planning notes' })
		core.register(fakeConn(), 'B')

		expect(seen).toEqual([])
	})

	it('binds and delivers even when the hook rejects', async () => {
		const core = createBrokerCore({ onRegistered: () => Promise.reject(new Error('boom')) })
		const conn = fakeConn()

		core.register(conn, 'A', { project: 'sessionbus', title: 'notes' })
		core.route('A', msg('m1'))
		await new Promise((r) => setTimeout(r, 0))

		expect(conn.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
		expect(core.connectedCount()).toBe(1)
	})

	it('binds and delivers while the hook never settles', () => {
		const core = createBrokerCore({ onRegistered: () => new Promise<void>(() => {}) })
		const conn = fakeConn()

		core.register(conn, 'A', { project: 'sessionbus', title: 'notes' })
		core.route('A', msg('m1'))

		expect(conn.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
	})
})

describe('onRouted hook', () => {
	it('fires once after delivery to a connected recipient', () => {
		const routed: ChannelMessage[] = []
		const core = createBrokerCore({
			onRouted: (m) => {
				routed.push(m)
			}
		})
		const b = fakeConn()
		core.register(b, 'B')
		core.route('B', msg('m1'))

		expect(b.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
		expect(routed).toEqual([msg('m1')])
	})

	it('fires once after queuing for an offline recipient', () => {
		const routed: ChannelMessage[] = []
		const core = createBrokerCore({
			onRouted: (m) => {
				routed.push(m)
			}
		})
		core.route('B', msg('m1'))
		expect(routed).toEqual([msg('m1')])

		// and the message is still waiting for B when it turns up
		const b = fakeConn()
		core.register(b, 'B')
		expect(b.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
		expect(routed).toHaveLength(1) // flushing a queue is not routing
	})

	it('fires once per fan-out recipient, all carrying the shared id', () => {
		const routed: ChannelMessage[] = []
		const core = createBrokerCore({
			onRouted: (m) => {
				routed.push(m)
			}
		})
		const shared = msg('broadcast-1')
		core.route('B', shared)
		core.route('C', shared)
		core.route('D', shared)

		expect(routed).toHaveLength(3)
		expect(routed.map((m) => m.id)).toEqual(['broadcast-1', 'broadcast-1', 'broadcast-1'])
	})

	it('fires for a message dropped by queue overflow: the hook observes routing, not delivery', () => {
		const routed: ChannelMessage[] = []
		const core = createBrokerCore({
			maxQueuePerSession: 1,
			onRouted: (m) => {
				routed.push(m)
			}
		})
		core.route('B', msg('m1'))
		core.route('B', msg('m2'))
		expect(routed.map((m) => m.id)).toEqual(['m1', 'm2'])
	})

	it('a throwing hook leaves delivery, queuing and the broker alone', () => {
		const core = createBrokerCore({
			onRouted: () => {
				throw new Error('matrix is down')
			}
		})
		const b = fakeConn()
		core.register(b, 'B')

		expect(() => core.route('B', msg('m1'))).not.toThrow()
		expect(b.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])

		// the offline path survives it too, and the broker keeps serving afterwards
		expect(() => core.route('C', msg('m2'))).not.toThrow()
		const c = fakeConn()
		core.register(c, 'C')
		expect(c.sent).toEqual([{ type: 'deliver', msg: msg('m2') }])
	})

	it('logs a throwing hook rather than swallowing it silently', () => {
		const logged: string[] = []
		const core = createBrokerCore({
			log: (m) => logged.push(m),
			onRouted: () => {
				throw new Error('matrix is down')
			}
		})
		core.route('B', msg('m1'))
		expect(logged.some((l) => l.includes('onRouted'))).toBe(true)
	})

	it('a hook returning a rejected promise never reaches the fatal handlers', async () => {
		const logged: string[] = []
		const core = createBrokerCore({
			log: (m) => logged.push(m),
			onRouted: () => Promise.reject(new Error('post failed')),
			maxQueuePerSession: 10
		})
		core.route('B', msg('m1'))
		await Promise.resolve()
		await Promise.resolve()
		expect(logged.some((l) => l.includes('onRouted'))).toBe(true)
	})

	it('routes exactly as before when no hook is configured', () => {
		const core = createBrokerCore()
		const b = fakeConn()
		core.register(b, 'B')
		core.route('B', msg('m1'))
		core.route('C', msg('m2'))
		const c = fakeConn()
		core.register(c, 'C')

		expect(b.sent).toEqual([{ type: 'deliver', msg: msg('m1') }])
		expect(c.sent).toEqual([{ type: 'deliver', msg: msg('m2') }])
	})
})

/** A wake as the relay builds one: a human sender, a window and the room it happened in. */
function wake(id: string, to: string): ChannelMessage {
	return {
		id,
		from: {
			sessionId: '@samer:host',
			userId: '@samer:host',
			name: 'Samer Z',
			role: 'none',
			origin: 'human'
		},
		to: { kind: 'session', value: to },
		text: '[14:02] Samer Z: ship it',
		createdAt: 0,
		relay: { room: '!epic:host', unread: 1, omitted: 0, since: 's-1' }
	}
}

describe('a relayed wake takes the local delivery path', () => {
	it('reaches a registered session exactly as a local send does', () => {
		const core = createBrokerCore()
		const conn = fakeConn()
		core.register(conn, 'sess-1', { project: 'proj', title: '1234 epic:42' })

		core.route(core.sessionForIdentity('proj/1234 epic:42') ?? '', wake('w1', 'sess-1'))

		// The welcome frame is the server's, not the core's: the core delivers and nothing else.
		expect(conn.sent).toEqual([{ type: 'deliver', msg: wake('w1', 'sess-1') }])
	})

	it('reaches the new session id after a re-register, and not the old one', () => {
		const core = createBrokerCore()
		const first = fakeConn()
		const second = fakeConn()
		const meta = { project: 'proj', title: '1234 epic:42' }
		core.register(first, 'sess-1', meta)
		core.register(second, 'sess-2', meta)

		// The relay looks the identity up at route time, which is the whole point: the id it
		// held a moment ago is now held by nobody.
		const to = core.sessionForIdentity('proj/1234 epic:42') ?? ''
		expect(to).toBe('sess-2')
		core.route(to, wake('w1', to))

		expect(second.sent.filter((f) => f.type === 'deliver')).toHaveLength(1)
		expect(first.sent.filter((f) => f.type === 'deliver')).toHaveLength(0)
	})

	it('keeps routing and stays alive when the register hook throws', () => {
		const core = createBrokerCore({
			onRegistered: () => {
				throw new Error('homeserver unreachable')
			}
		})
		const conn = fakeConn()

		expect(() => core.register(conn, 'sess-1', { project: 'proj', title: 'notes' })).not.toThrow()
		core.route('sess-1', wake('w1', 'sess-1'))

		expect(conn.sent.filter((f) => f.type === 'deliver')).toHaveLength(1)
	})

	it('keeps routing when the register hook rejects', async () => {
		const core = createBrokerCore({
			onRegistered: () => Promise.reject(new Error('homeserver unreachable'))
		})
		const conn = fakeConn()
		core.register(conn, 'sess-1', { project: 'proj', title: 'notes' })
		// Settle the rejected hook: an unhandled one would end the process, not this test.
		await Promise.resolve()

		core.route('sess-1', wake('w1', 'sess-1'))
		expect(conn.sent.filter((f) => f.type === 'deliver')).toHaveLength(1)
	})

	it('never mirrors a relayed wake back out: its sender has no session', () => {
		const mirrored: ChannelMessage[] = []
		const core = createBrokerCore({
			onRouted: (m) => {
				mirrored.push(m)
			}
		})
		const conn = fakeConn()
		core.register(conn, 'sess-1', { project: 'proj', title: 'notes' })

		core.route('sess-1', wake('w1', 'sess-1'))

		// The observer still sees it — the mirror recognises a human sender as one it has no
		// remote identity for and drops it, which is what keeps the loop from closing.
		expect(mirrored).toHaveLength(1)
		expect(core.identityForSession(mirrored[0].from.sessionId)).toBeUndefined()
	})
})
