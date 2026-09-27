import { describe, expect, it } from 'vitest'
import {
	type ChannelMessage,
	isThreadHandle,
	newMessageId,
	shortId,
	toChannelMeta
} from './message.ts'

const baseMsg = (over: Partial<ChannelMessage> = {}): ChannelMessage => ({
	id: 'zz-0000',
	from: {
		sessionId: '40b1b2a0-faee-4aa6-aa2c-a56535b547dd',
		name: '1234 epic:2345',
		epic: '2345',
		role: 'worker'
	},
	to: { kind: 'session', value: 'other' },
	text: 'hello',
	createdAt: 1784157712199,
	...over
})

describe('newMessageId', () => {
	it('encodes the timestamp in base36 with the random suffix', () => {
		expect(newMessageId(1000, 'abcd')).toBe(`${(1000).toString(36)}-abcd`)
	})

	it('produces distinct ids for distinct random suffixes', () => {
		expect(newMessageId(1000, 'aaaa')).not.toBe(newMessageId(1000, 'bbbb'))
	})
})

describe('shortId', () => {
	it('strips hyphens and takes the first six hex chars', () => {
		expect(shortId('40b1b2a0-faee-4aa6-aa2c-a56535b547dd')).toBe('40b1b2')
	})
})

describe('toChannelMeta', () => {
	it('maps identifier-safe keys and stringifies values', () => {
		const meta = toChannelMeta(baseMsg())
		expect(meta).toEqual({
			from: '1234 epic:2345',
			from_id: '40b1b2',
			origin: 'session',
			role: 'worker',
			epic: '2345',
			msg_id: 'zz-0000'
		})
		// no hyphenated keys (the channel contract silently drops them)
		expect(Object.keys(meta).some((k) => k.includes('-'))).toBe(false)
	})

	it('reports a locally routed message as session origin with the short session id', () => {
		const meta = toChannelMeta(baseMsg())
		expect(meta.origin).toBe('session')
		expect(meta.from_id).toBe('40b1b2')
	})

	it('omits epic when the sender has none', () => {
		const meta = toChannelMeta(baseMsg({ from: { sessionId: 'x', name: 'main-8d', role: 'none' } }))
		expect(meta.epic).toBeUndefined()
		expect(meta.role).toBe('none')
	})
})

describe('ChannelMessage.thread', () => {
	it('accepts a handle selector and leaves the rest of the message alone', () => {
		const msg = baseMsg({ thread: { kind: 'handle', handle: 't_9f2a' } })
		expect(msg.thread).toEqual({ kind: 'handle', handle: 't_9f2a' })
		expect(msg.text).toBe('hello')
	})

	it('accepts a new-thread selector carrying its title', () => {
		const msg = baseMsg({ thread: { kind: 'new', title: 'rollout plan' } })
		expect(msg.thread).toEqual({ kind: 'new', title: 'rollout plan' })
	})

	it('is optional: a message without one carries no thread', () => {
		expect(baseMsg().thread).toBeUndefined()
	})

	it('never reaches channel meta: a handle selector adds no key', () => {
		const withThread = toChannelMeta(baseMsg({ thread: { kind: 'handle', handle: 't_9f2a' } }))
		expect(withThread).toEqual(toChannelMeta(baseMsg()))
		expect(Object.keys(withThread)).not.toContain('thread')
	})

	it('never reaches channel meta: a new-thread selector adds no key', () => {
		const withThread = toChannelMeta(baseMsg({ thread: { kind: 'new', title: 'rollout plan' } }))
		expect(withThread).toEqual(toChannelMeta(baseMsg()))
	})
})

describe('isThreadHandle', () => {
	it('accepts the shapes the bridge mints', () => {
		expect(isThreadHandle('t_9f2a')).toBe(true)
		expect(isThreadHandle('t_0a1b2c3d')).toBe(true)
		expect(isThreadHandle('t_rs-37697c5f')).toBe(true) // a handle derived from a message id
		expect(isThreadHandle('t_A')).toBe(true)
	})

	it('rejects anything that is not one', () => {
		for (const bad of [
			'',
			't_',
			't',
			'x_9f2a',
			'9f2a',
			't_9f 2a',
			' t_9f2a',
			't_9f2a ',
			't_9f:2a'
		]) {
			expect(isThreadHandle(bad)).toBe(false)
		}
	})

	it('needs no lookup, so it answers the same way every time', () => {
		expect(isThreadHandle('t_9f2a')).toBe(isThreadHandle('t_9f2a'))
	})
})

const wakeMsg = (over: Partial<ChannelMessage> = {}): ChannelMessage =>
	baseMsg({
		from: {
			sessionId: '@samer:example.org',
			userId: '@samer:example.org',
			name: 'Samer Z',
			role: 'none',
			origin: 'human'
		},
		to: { kind: 'session', value: 'worker-session' },
		relay: { room: '!epic42:example.org', unread: 3, omitted: 5, since: 's-77' },
		...over
	})

describe('toChannelMeta (a relayed human wake)', () => {
	it('reports human origin, the full Matrix user id and no role', () => {
		const meta = toChannelMeta(wakeMsg())

		expect(meta.origin).toBe('human')
		expect(meta.from_id).toBe('@samer:example.org')
		expect(meta.role).toBe('none')
		expect(meta.from).toBe('Samer Z')
	})

	it('carries the window keys as strings', () => {
		const meta = toChannelMeta(wakeMsg())

		expect(meta.room).toBe('!epic42:example.org')
		expect(meta.unread).toBe('3')
		expect(meta.omitted).toBe('5')
		expect(meta.since).toBe('s-77')
	})

	it('renders a zero count as a decimal string rather than dropping it', () => {
		const meta = toChannelMeta(
			wakeMsg({ relay: { room: '!r:host', unread: 1, omitted: 0, since: 's-1' } })
		)

		expect(meta.omitted).toBe('0')
	})

	it('omits the thread keys for a message on the main timeline', () => {
		const meta = toChannelMeta(wakeMsg())

		expect(Object.keys(meta)).not.toContain('thread')
		expect(Object.keys(meta)).not.toContain('thread_title')
	})

	it('carries the thread keys for a threaded message', () => {
		const meta = toChannelMeta(
			wakeMsg({
				relay: {
					room: '!r:host',
					unread: 1,
					omitted: 0,
					since: 's-1',
					thread: 't_9f2a',
					threadTitle: 'rollout plan'
				}
			})
		)

		expect(meta.thread).toBe('t_9f2a')
		expect(meta.thread_title).toBe('rollout plan')
	})

	it('lists the other identities in mentions and not the woken one', () => {
		const meta = toChannelMeta(
			wakeMsg({
				relay: { room: '!r:host', unread: 1, omitted: 0, since: 's-1', mentions: ['5678 epic:42'] }
			})
		)

		expect(meta.mentions).toBe('5678 epic:42')
		expect(meta.mentions).not.toContain('1234 epic:2345')
	})

	it('joins several other identities with a comma', () => {
		const meta = toChannelMeta(
			wakeMsg({
				relay: {
					room: '!r:host',
					unread: 1,
					omitted: 0,
					since: 's-1',
					mentions: ['5678 epic:42', '9012 epic:42']
				}
			})
		)

		expect(meta.mentions).toBe('5678 epic:42,9012 epic:42')
	})

	it('omits mentions when nobody else was named', () => {
		expect(Object.keys(toChannelMeta(wakeMsg()))).not.toContain('mentions')
		const empty = toChannelMeta(
			wakeMsg({ relay: { room: '!r:host', unread: 1, omitted: 0, since: 's-1', mentions: [] } })
		)
		expect(Object.keys(empty)).not.toContain('mentions')
	})

	it('adds no window key to a message that was not relayed', () => {
		for (const key of ['room', 'unread', 'omitted', 'since']) {
			expect(Object.keys(toChannelMeta(baseMsg()))).not.toContain(key)
		}
	})
})

describe('toChannelMeta (blind spots)', () => {
	it('emits only identifier-safe keys and string values, for either origin', () => {
		const identifierSafe = /^[A-Za-z_][A-Za-z0-9_]*$/
		const both = [
			toChannelMeta(baseMsg()),
			toChannelMeta(
				wakeMsg({
					relay: {
						room: '!r:host',
						unread: 12,
						omitted: 0,
						since: 's-1',
						thread: 't_9f2a',
						threadTitle: 'rollout plan',
						mentions: ['5678 epic:42']
					}
				})
			)
		]
		for (const meta of both) {
			for (const [key, value] of Object.entries(meta)) {
				expect(key).toMatch(identifierSafe)
				expect(typeof value).toBe('string')
			}
		}
	})

	it('is pure: mapping the same message twice gives deep-equal meta', () => {
		const msg = wakeMsg()
		expect(toChannelMeta(msg)).toEqual(toChannelMeta(msg))
	})
})
