import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileMailbox } from './mailbox.ts'
import type { ChannelMessage } from './message.ts'
import { createTransport } from './transport.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
	for (const c of cleanups.splice(0)) c()
})

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), 'ch-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	return dir
}

function msg(id: string): ChannelMessage {
	return {
		id,
		from: { sessionId: 'x', name: 'x', role: 'none' },
		to: { kind: 'session', value: 'own' },
		text: id,
		createdAt: 0
	}
}

describe('createTransport', () => {
	it('file mode reads the file mailbox inbox', () => {
		const channelsHome = tempHome()
		createFileMailbox(channelsHome).send('own', msg('m1')) // seed own inbox
		const t = createTransport({
			channelsHome,
			socketPath: join(channelsHome, 'broker.sock'),
			mode: 'file'
		})
		expect(t.poll('own').map((m) => m.id)).toEqual(['m1'])
	})

	it('socket mode does not read the file mailbox (poll returns [])', () => {
		const channelsHome = tempHome()
		createFileMailbox(channelsHome).send('own', msg('m1')) // seed own inbox
		const t = createTransport({
			channelsHome,
			socketPath: join(channelsHome, 'broker.sock'),
			mode: 'socket'
		})
		expect(t.poll('own')).toEqual([])
	})

	it('defaults to file when SESSIONBUS_TRANSPORT is unset', () => {
		const channelsHome = tempHome()
		createFileMailbox(channelsHome).send('own', msg('m1'))
		const prev = process.env.SESSIONBUS_TRANSPORT
		process.env.SESSIONBUS_TRANSPORT = undefined
		cleanups.push(() => {
			if (prev === undefined) delete process.env.SESSIONBUS_TRANSPORT
			else process.env.SESSIONBUS_TRANSPORT = prev
		})
		delete process.env.SESSIONBUS_TRANSPORT
		const t = createTransport({ channelsHome, socketPath: join(channelsHome, 'broker.sock') })
		expect(t.poll('own').map((m) => m.id)).toEqual(['m1'])
	})

	it('warns to stderr and falls back to file on an unrecognized SESSIONBUS_TRANSPORT value', () => {
		const channelsHome = tempHome()
		createFileMailbox(channelsHome).send('own', msg('m1'))
		const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		cleanups.push(() => writeSpy.mockRestore())
		const t = createTransport({
			channelsHome,
			socketPath: join(channelsHome, 'broker.sock'),
			mode: 'bogus'
		})
		expect(t.poll('own').map((m) => m.id)).toEqual(['m1'])
		expect(writeSpy).toHaveBeenCalledWith(expect.stringMatching(/unknown SESSIONBUS_TRANSPORT/))
	})
})
