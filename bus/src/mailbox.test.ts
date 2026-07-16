import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createFileMailbox } from './mailbox.ts'
import type { ChannelMessage } from './message.ts'

let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'sb-mb-'))
})

const msg = (id: string, text = 'hi'): ChannelMessage => ({
	id,
	from: { sessionId: 'sender', name: '1234 epic:2345', epic: '2345', role: 'worker' },
	to: { kind: 'session', value: 'recipient' },
	text,
	createdAt: 1784157712199
})

describe('send + poll', () => {
	it('delivers a sent message to the recipient inbox exactly once', () => {
		const mb = createFileMailbox(home)
		mb.send('recipient', msg('aa-1'))

		const first = mb.poll('recipient')
		expect(first.map((m) => m.id)).toEqual(['aa-1'])

		// second poll sees nothing new (file archived + id remembered)
		expect(mb.poll('recipient')).toEqual([])
	})

	it('leaves no .tmp files and archives to consumed/', () => {
		const mb = createFileMailbox(home)
		mb.send('recipient', msg('aa-2'))
		mb.poll('recipient')

		const inbox = join(home, 'bus', 'recipient')
		expect(readdirSync(inbox).filter((f) => f.endsWith('.json'))).toEqual([])
		expect(existsSync(join(inbox, 'consumed', 'aa-2.json'))).toBe(true)
		expect(readdirSync(inbox).some((f) => f.includes('.tmp'))).toBe(false)
	})

	it('delivers messages queued before the recipient started polling (offline case)', () => {
		const mb = createFileMailbox(home)
		mb.send('recipient', msg('aa-3'))
		mb.send('recipient', msg('bb-4'))
		const got = mb
			.poll('recipient')
			.map((m) => m.id)
			.sort()
		expect(got).toEqual(['aa-3', 'bb-4'])
	})

	it('returns empty for an inbox that never received anything', () => {
		const mb = createFileMailbox(home)
		expect(mb.poll('nobody')).toEqual([])
	})
})

describe('watch', () => {
	it('invokes the callback for a message that arrives after watching starts', async () => {
		const mb = createFileMailbox(home)
		const seen: string[] = []
		const stop = mb.watch('recipient', (m) => seen.push(m.id))
		mb.send('recipient', msg('cc-5'))
		await new Promise((r) => setTimeout(r, 1300)) // allow poll interval to fire
		stop()
		expect(seen).toContain('cc-5')
	})

	it('drains messages already queued before watch starts (initial drain)', () => {
		const mb = createFileMailbox(home)
		mb.send('recipient', msg('aa-pre1'))
		mb.send('recipient', msg('bb-pre2'))
		const seen: string[] = []
		const stop = mb.watch('recipient', (m) => seen.push(m.id))
		stop()
		expect(seen.sort()).toEqual(['aa-pre1', 'bb-pre2'])
	})

	it('stop() halts delivery: a message sent after stop is not delivered', async () => {
		const mb = createFileMailbox(home)
		const seen: string[] = []
		const stop = mb.watch('recipient', (m) => seen.push(m.id))
		stop()
		mb.send('recipient', msg('cc-after'))
		await new Promise((r) => setTimeout(r, 1300)) // longer than the 1s poll interval
		expect(seen).not.toContain('cc-after')
	})
})
