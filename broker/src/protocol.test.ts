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
