import { describe, expect, it } from 'vitest'
import { type ChannelMessage, newMessageId, shortId, toChannelMeta } from './message.ts'

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
			role: 'worker',
			epic: '2345',
			msg_id: 'zz-0000'
		})
		// no hyphenated keys (the channel contract silently drops them)
		expect(Object.keys(meta).some((k) => k.includes('-'))).toBe(false)
	})

	it('omits epic when the sender has none', () => {
		const meta = toChannelMeta(baseMsg({ from: { sessionId: 'x', name: 'main-8d', role: 'none' } }))
		expect(meta.epic).toBeUndefined()
		expect(meta.role).toBe('none')
	})
})
