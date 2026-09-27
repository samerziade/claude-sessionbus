import { describe, expect, it } from 'vitest'
import type { ChannelMessage } from '../../bus/src/message.ts'
import { createFrameDecoder, encodeFrame, type Frame } from './protocol.ts'

const MSG: ChannelMessage = {
	id: 'abc-1',
	from: { sessionId: 's-from', name: 'from', role: 'none' },
	to: { kind: 'session', value: 's-to' },
	text: 'hello',
	createdAt: 1
}

describe('protocol codec', () => {
	it('round-trips a frame through encode + decode', () => {
		const frame: Frame = { type: 'deliver', msg: MSG }
		const decode = createFrameDecoder()
		expect(decode(encodeFrame(frame))).toEqual([frame])
	})

	it('reassembles a frame split across two chunks', () => {
		const frame: Frame = { type: 'send', to: 's-to', msg: MSG }
		const wire = encodeFrame(frame)
		const cut = Math.floor(wire.length / 2)
		const decode = createFrameDecoder()
		expect(decode(wire.slice(0, cut))).toEqual([])
		expect(decode(wire.slice(cut))).toEqual([frame])
	})

	it('skips an unparseable line without dropping the next frame', () => {
		const good: Frame = { type: 'register', sessionId: 's', protocolVersion: 1 }
		const decode = createFrameDecoder()
		const wire = `{not json\n${encodeFrame(good)}`
		expect(decode(wire)).toEqual([good])
	})
})

describe('register frame announcements', () => {
	it('round-trips a register frame carrying a project and a title', () => {
		const frame: Frame = {
			type: 'register',
			sessionId: 's',
			protocolVersion: 1,
			project: 'sessionbus',
			title: '123 epic:42'
		}
		const decode = createFrameDecoder()
		expect(decode(encodeFrame(frame))).toEqual([frame])
	})

	it('still decodes a register frame carrying neither field', () => {
		const frame: Frame = { type: 'register', sessionId: 's', protocolVersion: 1 }
		const decode = createFrameDecoder()
		expect(decode(encodeFrame(frame))).toEqual([frame])
	})

	it('still decodes a frame carrying a key it does not know', () => {
		const decode = createFrameDecoder()
		const line = `${JSON.stringify({
			type: 'register',
			sessionId: 's',
			protocolVersion: 1,
			somethingNewer: 42
		})}\n`

		const frames = decode(line)

		expect(frames).toHaveLength(1)
		expect(frames[0].type).toBe('register')
	})
})

describe('history and reply frames', () => {
	it('round-trips a history request with its correlation id', () => {
		const frame: Frame = {
			type: 'history',
			id: 'req-1',
			query: { room: '!epic:host', since: 's-1', limit: 5, search: 'beacon' }
		}
		const decode = createFrameDecoder()
		expect(decode(encodeFrame(frame))).toEqual([frame])
	})

	it('round-trips a history reply with its correlation id', () => {
		const frame: Frame = {
			type: 'history_reply',
			id: 'req-1',
			result: {
				ok: true,
				room: '!epic:host',
				messages: [
					{
						from: 'Samer Z',
						from_id: '@samer:host',
						origin: 'human',
						text: 'ship it',
						at: 5,
						thread: 't_9f2a'
					}
				],
				more: true
			}
		}
		const decode = createFrameDecoder()
		expect(decode(encodeFrame(frame))).toEqual([frame])
	})

	it('round-trips a failed history reply', () => {
		const frame: Frame = {
			type: 'history_reply',
			id: 'req-1',
			result: { ok: false, reason: 'not_found' }
		}
		const decode = createFrameDecoder()
		expect(decode(encodeFrame(frame))).toEqual([frame])
	})

	it('round-trips a Matrix reply request and its answer', () => {
		const request: Frame = {
			type: 'matrix_reply',
			id: 'req-2',
			request: { to: '@samer:host', text: 'on it' }
		}
		const reply: Frame = {
			type: 'matrix_reply_result',
			id: 'req-2',
			result: { ok: true, room: '!epic:host', thread: 't_9f2a' }
		}
		const decode = createFrameDecoder()
		expect(decode(encodeFrame(request) + encodeFrame(reply))).toEqual([request, reply])
	})

	it('correlates two outstanding requests by their own ids', () => {
		const decode = createFrameDecoder()
		const first: Frame = { type: 'history', id: 'a', query: {} }
		const second: Frame = { type: 'history', id: 'b', query: {} }

		expect(
			decode(encodeFrame(first) + encodeFrame(second)).map((f) => f.type === 'history' && f.id)
		).toEqual(['a', 'b'])
	})

	it('skips a frame type it does not know without breaking the buffer', () => {
		const decode = createFrameDecoder()
		const known: Frame = { type: 'history', id: 'a', query: {} }
		const chunk = `${JSON.stringify({ type: 'from_the_future', id: 'x' })}\n${encodeFrame(known)}`

		expect(decode(chunk)).toEqual([known])
	})
})
