import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChannelNotification, createHandlers, type HandlerDeps } from './handlers.ts'
import type { PeerIdentity } from './identity.ts'
import { createFileMailbox } from './mailbox.ts'
import { writeBeacon } from './registry.ts'

let home: string
let sessionsDir: string

const workerSelf: PeerIdentity = {
	sessionId: 'wkr-1234',
	name: '1234 epic:2345',
	role: 'worker',
	issue: '1234',
	epic: '2345'
}
const pmSelf: PeerIdentity = { sessionId: 'pm-2345', name: 'epic:2345', role: 'pm', epic: '2345' }

function seedRegistry() {
	// both sessions live in the registry + presence, both pids alive (use ours)
	writeFileSync(
		join(sessionsDir, 'w.json'),
		JSON.stringify({
			sessionId: 'wkr-1234',
			pid: process.pid,
			name: '1234 epic:2345',
			status: 'busy',
			cwd: '/repo',
			updatedAt: 111
		})
	)
	writeFileSync(
		join(sessionsDir, 'p.json'),
		JSON.stringify({
			sessionId: 'pm-2345',
			pid: process.pid,
			name: 'epic:2345',
			status: 'idle',
			cwd: '/repo',
			updatedAt: 222
		})
	)
	writeBeacon(home, {
		sessionId: 'wkr-1234',
		pid: process.pid,
		name: '1234 epic:2345',
		role: 'worker',
		epic: '2345',
		startedAt: 1
	})
	writeBeacon(home, {
		sessionId: 'pm-2345',
		pid: process.pid,
		name: 'epic:2345',
		role: 'pm',
		epic: '2345',
		startedAt: 1
	})
}

function deps(self: PeerIdentity, notify = vi.fn().mockResolvedValue(undefined)): HandlerDeps {
	return {
		self: () => self,
		channelsHome: home,
		sessionsDir,
		transport: createFileMailbox(home),
		notify,
		now: () => 1000
	}
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'sb-h-'))
	sessionsDir = mkdtempSync(join(tmpdir(), 'sb-s-'))
	mkdirSync(sessionsDir, { recursive: true })
	seedRegistry()
})

describe('whoami', () => {
	it('returns the caller identity', () => {
		expect(createHandlers(deps(workerSelf)).whoami()).toEqual(workerSelf)
	})

	it('re-derives identity per call so a rename after startup is reflected', () => {
		// A session launched before it was named reads as a plain peer; the operator renames it
		// to "1234 epic:2345" seconds later. Identity must not be frozen at startup.
		const unnamed: PeerIdentity = { sessionId: 'wkr-1234', name: 'main-f4', role: 'none' }
		let current = unnamed
		const h = createHandlers({ ...deps(unnamed), self: () => current })

		expect(h.whoami()).toMatchObject({ name: 'main-f4', role: 'none' })
		current = workerSelf
		expect(h.whoami()).toMatchObject({ name: '1234 epic:2345', role: 'worker', epic: '2345' })
	})

	it('routes "pm" correctly only after a rename gives us an epic', () => {
		const unnamed: PeerIdentity = { sessionId: 'wkr-1234', name: 'main-f4', role: 'none' }
		let current = unnamed
		const h = createHandlers({ ...deps(unnamed), self: () => current })

		// no epic yet -> "pm" is unroutable
		expect(h.sendMessage({ to: 'pm', text: 'early' })).toMatchObject({ ok: false })
		current = workerSelf
		expect(h.sendMessage({ to: 'pm', text: 'later' })).toMatchObject({ ok: true, count: 1 })
	})
})

describe('listPeers', () => {
	it('lists same-epic peers excluding self', () => {
		const peers = createHandlers(deps(workerSelf)).listPeers({ scope: 'epic' })
		expect(peers.map((p) => p.sessionId)).toEqual(['pm-2345'])
		expect(peers[0]).toMatchObject({ role: 'pm', epic: '2345', status: 'idle', shortId: 'pm2345' })
	})
})

describe('sendMessage', () => {
	it('routes "pm" to the PM inbox and reports one recipient', () => {
		const h = createHandlers(deps(workerSelf))
		const res = h.sendMessage({ to: 'pm', text: 'openspec ready for #1234' })
		expect(res).toMatchObject({ ok: true, kind: 'session', count: 1 })
		if (res.ok) expect(res.recipients[0].sessionId).toBe('pm-2345')

		// the PM can now poll its inbox and see the message
		const pmTransport = createFileMailbox(home)
		const got = pmTransport.poll('pm-2345')
		expect(got).toHaveLength(1)
		expect(got[0].text).toBe('openspec ready for #1234')
		expect(got[0].from.name).toBe('1234 epic:2345')
	})

	it('returns not_found without writing when the target is unknown', () => {
		const res = createHandlers(deps(workerSelf)).sendMessage({ to: 'nobody', text: 'x' })
		expect(res).toEqual({ ok: false, reason: 'not_found' })
	})

	it('broadcast to "epic" fans out a distinct message to every same-epic peer', () => {
		// add a second worker in epic 2345 (registry + live beacon)
		writeFileSync(
			join(sessionsDir, 'w2.json'),
			JSON.stringify({
				sessionId: 'wkr-9999',
				pid: process.pid,
				name: '9999 epic:2345',
				status: 'idle',
				cwd: '/repo',
				updatedAt: 333
			})
		)
		writeBeacon(home, {
			sessionId: 'wkr-9999',
			pid: process.pid,
			name: '9999 epic:2345',
			role: 'worker',
			epic: '2345',
			startedAt: 1
		})

		const res = createHandlers(deps(pmSelf)).sendMessage({ to: 'epic', text: 'standup in 5' })
		expect(res).toMatchObject({ ok: true, kind: 'epic', count: 2 })
		if (res.ok)
			expect(res.recipients.map((r) => r.sessionId).sort()).toEqual(['wkr-1234', 'wkr-9999'])

		const mb = createFileMailbox(home)
		const a = mb.poll('wkr-1234')
		const b = mb.poll('wkr-9999')
		expect(a).toHaveLength(1)
		expect(b).toHaveLength(1)
		expect(a[0].text).toBe('standup in 5')
		expect(b[0].text).toBe('standup in 5')
		expect(a[0].id).not.toBe(b[0].id) // distinct id per recipient
	})
})

describe('start -> inbound bridge', () => {
	it('delivers an incoming message to notify() as a channel event', async () => {
		const notify = vi.fn().mockResolvedValue(undefined)
		const pmHandlers = createHandlers(deps(pmSelf, notify))
		const stop = pmHandlers.start()

		// worker sends to the PM
		createHandlers(deps(workerSelf)).sendMessage({ to: 'pm', text: 'ping' })

		await new Promise((r) => setTimeout(r, 1300))
		stop()

		expect(notify).toHaveBeenCalledTimes(1)
		const arg = notify.mock.calls[0][0]
		expect(arg.content).toBe('ping')
		expect(arg.meta).toMatchObject({
			from: '1234 epic:2345',
			from_id: 'wkr123',
			role: 'worker',
			epic: '2345'
		})
	})
})

describe('buildChannelNotification', () => {
	it('maps content + meta', () => {
		const n = buildChannelNotification({
			id: 'zz-1',
			from: { sessionId: 'wkr-1234', name: '1234 epic:2345', epic: '2345', role: 'worker' },
			to: { kind: 'session', value: 'pm-2345' },
			text: 'body',
			createdAt: 1
		})
		expect(n.content).toBe('body')
		expect(n.meta.msg_id).toBe('zz-1')
	})
})

describe('livePeers intersection', () => {
	it('excludes a session that has a registry entry but no live beacon', () => {
		writeFileSync(
			join(sessionsDir, 'ghost.json'),
			JSON.stringify({
				sessionId: 'ghost-1',
				pid: process.pid,
				name: '4321 epic:2345',
				status: 'idle',
				cwd: '/repo',
				updatedAt: 444
			})
		)
		const peers = createHandlers(deps(workerSelf)).listPeers({ scope: 'epic' })
		expect(peers.map((p) => p.sessionId)).toEqual(['pm-2345']) // ghost-1 absent: no beacon
	})

	it('excludes a session that has a beacon but no registry entry', () => {
		writeBeacon(home, {
			sessionId: 'orphan-1',
			pid: process.pid,
			name: '5555 epic:2345',
			role: 'worker',
			epic: '2345',
			startedAt: 1
		})
		const peers = createHandlers(deps(workerSelf)).listPeers({ scope: 'epic' })
		expect(peers.map((p) => p.sessionId)).toEqual(['pm-2345']) // orphan-1 absent: no registry entry
	})
})
