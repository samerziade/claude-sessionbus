import { describe, expect, it } from 'vitest'
import {
	type BuildWindowInput,
	buildWindow,
	renderTranscript,
	type WindowMessage
} from './matrix-window.ts'

const CAPS = { messages: 20, chars: 2000 }

function at(hour: number, minute: number): number {
	return Date.UTC(2024, 0, 15, hour, minute)
}

function message(over: Partial<WindowMessage> = {}): WindowMessage {
	return {
		eventId: '$e-1',
		sender: '@samer:host',
		senderDisplayName: 'Samer Z',
		body: 'ping',
		at: at(14, 2),
		...over
	}
}

function input(over: Partial<BuildWindowInput> = {}): BuildWindowInput {
	return { messages: [message()], caps: CAPS, ...over }
}

/** `n` short messages, oldest first, each body naming its own position. */
function series(n: number, over: Partial<WindowMessage> = {}): WindowMessage[] {
	return Array.from({ length: n }, (_, i) =>
		message({ eventId: `$e-${i}`, body: `m${i}`, at: at(14, i), ...over })
	)
}

describe('buildWindow (happy path)', () => {
	it('carries every unread message when nothing is capped', () => {
		const messages = series(3)
		const result = buildWindow(input({ messages }))

		expect(result.unread).toBe(3)
		expect(result.omitted).toBe(0)
		expect(result.content).toBe(
			['[14:00] Samer Z: m0', '[14:01] Samer Z: m1', '[14:02] Samer Z: m2'].join('\n')
		)
	})
})

describe('buildWindow (caps)', () => {
	it('keeps the newest when the message cap binds', () => {
		const result = buildWindow(input({ messages: series(25), caps: { messages: 20, chars: 2000 } }))

		expect(result.unread).toBe(20)
		expect(result.omitted).toBe(5)
		expect(result.content.split('\n')[0]).toContain('m5')
		expect(result.content).not.toContain('m4:')
		expect(result.content.split('\n')).toHaveLength(20)
	})

	it('truncates to the character cap and reports what it dropped', () => {
		// Each line is `[14:0N] Samer Z: mN` — 19 characters, 20 with its newline.
		const result = buildWindow(input({ messages: series(6), caps: { messages: 20, chars: 60 } }))

		expect(result.content.length).toBeLessThanOrEqual(60)
		expect(result.omitted).toBeGreaterThan(0)
		expect(result.unread + result.omitted).toBe(6)
		expect(result.content).toContain('m5')
	})
})

describe('buildWindow (edge cases)', () => {
	it('does not truncate a backlog that is exactly the message cap', () => {
		const result = buildWindow(input({ messages: series(20), caps: { messages: 20, chars: 2000 } }))

		expect(result.unread).toBe(20)
		expect(result.omitted).toBe(0)
	})

	it('reports a lone mention as one unread and nothing omitted', () => {
		const result = buildWindow(input({ messages: [message({ body: 'hey' })] }))

		expect(result).toEqual({ content: '[14:02] Samer Z: hey', unread: 1, omitted: 0 })
	})

	it('keeps the waking event even when it alone exceeds the character cap', () => {
		const messages = [...series(3), message({ eventId: '$long', body: 'x'.repeat(200) })]
		const result = buildWindow(input({ messages, caps: { messages: 20, chars: 50 } }))

		expect(result.unread).toBe(1)
		expect(result.omitted).toBe(3)
		expect(result.content).toBe(`[14:02] Samer Z: ${'x'.repeat(200)}`)
	})

	it('returns an empty window for no messages', () => {
		expect(buildWindow(input({ messages: [] }))).toEqual({ content: '', unread: 0, omitted: 0 })
	})
})

describe('renderTranscript', () => {
	it('renders the line shape', () => {
		expect(renderTranscript([message({ body: 'deploy when ready' })])).toBe(
			'[14:02] Samer Z: deploy when ready'
		)
	})

	it('falls back to the localpart when the sender has no display name', () => {
		expect(renderTranscript([message({ senderDisplayName: undefined })])).toBe(
			'[14:02] samer: ping'
		)
	})

	it('falls back to the localpart when the display name is empty', () => {
		expect(renderTranscript([message({ senderDisplayName: '' })])).toBe('[14:02] samer: ping')
	})

	it('zero pads a single-digit hour and minute', () => {
		expect(renderTranscript([message({ at: at(9, 5) })])).toBe('[09:05] Samer Z: ping')
	})

	it('shifts the clock by the injected offset', () => {
		expect(renderTranscript([message({ at: at(14, 2) })], undefined, -300)).toBe(
			'[09:02] Samer Z: ping'
		)
	})

	it("carries an off-thread line's handle and leaves the wake's own lines bare", () => {
		const lines = renderTranscript(
			[
				message({ eventId: '$a', body: 'elsewhere', threadHandle: 't_9f2a', at: at(14, 0) }),
				message({ eventId: '$b', body: 'here', threadHandle: 't_beef', at: at(14, 1) })
			],
			't_beef'
		).split('\n')

		expect(lines[0]).toBe('[14:00] (t_9f2a) Samer Z: elsewhere')
		expect(lines[1]).toBe('[14:01] Samer Z: here')
	})

	it('carries a thread handle when the wake itself is on the main timeline', () => {
		expect(renderTranscript([message({ threadHandle: 't_9f2a' })])).toBe(
			'[14:02] (t_9f2a) Samer Z: ping'
		)
	})

	it('keeps a multi-line body verbatim and prefixes only its first line', () => {
		expect(renderTranscript([message({ body: 'first\nsecond' })])).toBe(
			'[14:02] Samer Z: first\nsecond'
		)
	})

	it('joins lines with one newline and leaves no trailing newline', () => {
		const rendered = renderTranscript(series(3))

		expect(rendered.endsWith('\n')).toBe(false)
		expect(rendered.split('\n')).toHaveLength(3)
	})

	it('renders no Matrix event id anywhere', () => {
		const rendered = renderTranscript(
			[
				message({ eventId: '$aaaaaaaaaaaaaaaaaaaa', threadHandle: 't_9f2a' }),
				message({ eventId: '$bbbbbbbbbbbbbbbbbbbb' })
			],
			't_beef'
		)

		expect(rendered).not.toContain('$')
	})
})

describe('buildWindow (blind spots)', () => {
	it('spans the main timeline and the threads, counting both', () => {
		const messages = [
			message({ eventId: '$a', body: 'on the timeline', at: at(14, 0) }),
			message({ eventId: '$b', body: 'in a thread', at: at(14, 1), threadHandle: 't_9f2a' }),
			message({ eventId: '$c', body: 'hey @w', at: at(14, 2) })
		]
		const result = buildWindow(input({ messages }))

		expect(result.unread).toBe(3)
		expect(result.content).toContain('on the timeline')
		expect(result.content).toContain('in a thread')
	})

	it('always reports the whole backlog as unread plus omitted', () => {
		for (const total of [1, 5, 20, 21, 64]) {
			const result = buildWindow(input({ messages: series(total) }))
			expect(result.unread + result.omitted).toBe(total)
		}
	})

	it('is pure: same input, deep-equal results, and no argument mutated', () => {
		const messages = series(25)
		const snapshot = structuredClone(messages)
		const args = input({ messages, caps: { messages: 20, chars: 2000 } })

		const first = buildWindow(args)
		const second = buildWindow(args)

		expect(first).toEqual(second)
		expect(messages).toEqual(snapshot)
		expect(args.caps).toEqual({ messages: 20, chars: 2000 })
	})
})
