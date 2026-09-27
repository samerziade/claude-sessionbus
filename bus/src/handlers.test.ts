import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChannelNotification, createHandlers, type HandlerDeps } from './handlers.ts'
import type { PeerIdentity } from './identity.ts'
import {
	createFileMailbox,
	type HistoryQuery,
	type HistoryResult,
	type MatrixReplyRequest,
	type MatrixReplyResult,
	type Transport
} from './mailbox.ts'
import type { ChannelMessage } from './message.ts'
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

/** A second worker in epic 2345 (registry entry + live beacon), for fan-out cases. */
function seedSecondWorker() {
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
	it('returns the caller identity', async () => {
		expect(createHandlers(deps(workerSelf)).whoami()).toEqual(workerSelf)
	})

	it('re-derives identity per call so a rename after startup is reflected', async () => {
		// A session launched before it was named reads as a plain peer; the operator renames it
		// to "1234 epic:2345" seconds later. Identity must not be frozen at startup.
		const unnamed: PeerIdentity = { sessionId: 'wkr-1234', name: 'main-f4', role: 'none' }
		let current = unnamed
		const h = createHandlers({ ...deps(unnamed), self: () => current })

		expect(h.whoami()).toMatchObject({ name: 'main-f4', role: 'none' })
		current = workerSelf
		expect(h.whoami()).toMatchObject({ name: '1234 epic:2345', role: 'worker', epic: '2345' })
	})

	it('routes "pm" correctly only after a rename gives us an epic', async () => {
		const unnamed: PeerIdentity = { sessionId: 'wkr-1234', name: 'main-f4', role: 'none' }
		let current = unnamed
		const h = createHandlers({ ...deps(unnamed), self: () => current })

		// no epic yet -> "pm" is unroutable
		expect(await h.sendMessage({ to: 'pm', text: 'early' })).toMatchObject({ ok: false })
		current = workerSelf
		expect(await h.sendMessage({ to: 'pm', text: 'later' })).toMatchObject({ ok: true, count: 1 })
	})
})

describe('listPeers', () => {
	it('lists same-epic peers excluding self', async () => {
		const peers = createHandlers(deps(workerSelf)).listPeers({ scope: 'epic' })
		expect(peers.map((p) => p.sessionId)).toEqual(['pm-2345'])
		expect(peers[0]).toMatchObject({ role: 'pm', epic: '2345', status: 'idle', shortId: 'pm2345' })
	})
})

describe('sendMessage', () => {
	it('routes "pm" to the PM inbox and reports one recipient', async () => {
		const h = createHandlers(deps(workerSelf))
		const res = await h.sendMessage({ to: 'pm', text: 'openspec ready for #1234' })
		expect(res).toMatchObject({ ok: true, kind: 'session', count: 1 })
		if (res.ok && res.kind !== 'matrix') expect(res.recipients[0].sessionId).toBe('pm-2345')

		// the PM can now poll its inbox and see the message
		const pmTransport = createFileMailbox(home)
		const got = pmTransport.poll('pm-2345')
		expect(got).toHaveLength(1)
		expect(got[0].text).toBe('openspec ready for #1234')
		expect(got[0].from.name).toBe('1234 epic:2345')
	})

	it('returns not_found without writing when the target is unknown', async () => {
		const res = await createHandlers(deps(workerSelf)).sendMessage({ to: 'nobody', text: 'x' })
		expect(res).toEqual({ ok: false, reason: 'not_found' })
	})

	it('broadcast to "epic" fans one message out to every same-epic peer', async () => {
		seedSecondWorker()

		const res = await createHandlers(deps(pmSelf)).sendMessage({ to: 'epic', text: 'standup in 5' })
		expect(res).toMatchObject({ ok: true, kind: 'epic', count: 2 })
		if (res.ok && res.kind !== 'matrix') {
			expect(res.recipients.map((r) => r.sessionId).sort()).toEqual(['wkr-1234', 'wkr-9999'])
		}

		const mb = createFileMailbox(home)
		const a = mb.poll('wkr-1234')
		const b = mb.poll('wkr-9999')
		expect(a).toHaveLength(1)
		expect(b).toHaveLength(1)
		expect(a[0].text).toBe('standup in 5')
		expect(b[0].text).toBe('standup in 5')
		// One logical message, N deliveries: the mirror dedupes by id, so a per-recipient id
		// would mirror a broadcast once per member.
		expect(a[0].id).toBe(b[0].id)
	})

	it('a broadcast with no live epic members writes nothing and routes nothing', async () => {
		// Nothing is routed, so nothing downstream — the outbound mirror included — ever sees it.
		const lonely: PeerIdentity = { sessionId: 'solo-1', name: 'epic:77', role: 'pm', epic: '77' }
		writeFileSync(
			join(sessionsDir, 'solo.json'),
			JSON.stringify({
				sessionId: 'solo-1',
				pid: process.pid,
				name: 'epic:77',
				status: 'idle',
				cwd: '/repo',
				updatedAt: 555
			})
		)
		writeBeacon(home, {
			sessionId: 'solo-1',
			pid: process.pid,
			name: 'epic:77',
			role: 'pm',
			epic: '77',
			startedAt: 1
		})

		const sent: string[] = []
		const transport = createFileMailbox(home)
		const res = await createHandlers({
			...deps(lonely),
			transport: {
				...transport,
				send: (recipient, m) => {
					sent.push(recipient)
					transport.send(recipient, m)
				}
			}
		}).sendMessage({ to: 'epic', text: 'anyone there' })

		expect(res).toMatchObject({ ok: true, kind: 'epic', count: 0 })
		expect(sent).toEqual([])
	})

	it('a list `to` fans one message out to every named recipient', async () => {
		const res = await createHandlers(deps(pmSelf)).sendMessage({
			to: ['wkr-1234', 'wkr1'],
			text: 'two ways to name one peer'
		})
		expect(res).toMatchObject({ ok: true, kind: 'session', count: 1 })

		const got = createFileMailbox(home).poll('wkr-1234')
		expect(got).toHaveLength(1)
	})

	it('a list `to` naming two peers writes both copies under one id', async () => {
		seedSecondWorker()
		const res = await createHandlers(deps(pmSelf)).sendMessage({
			to: ['wkr-1234', 'wkr-9999'],
			text: 'pair up'
		})
		expect(res).toMatchObject({ ok: true, kind: 'session', count: 2 })

		const a = createFileMailbox(home).poll('wkr-1234')
		const b = createFileMailbox(home).poll('wkr-9999')
		expect(a).toHaveLength(1)
		expect(b).toHaveLength(1)
		expect(a[0].id).toBe(b[0].id)
		expect(a[0].to.recipients).toEqual(['wkr-1234', 'wkr-9999'])
		expect(b[0].to.recipients).toEqual(['wkr-1234', 'wkr-9999'])
	})

	it('a single-recipient send carries no recipient list', async () => {
		await createHandlers(deps(workerSelf)).sendMessage({ to: 'pm', text: 'solo' })
		const got = createFileMailbox(home).poll('pm-2345')
		expect(got[0].to).toEqual({ kind: 'session', value: 'pm-2345' })
	})

	it('a list mixing a broadcast target with a named peer writes nothing', async () => {
		const res = await createHandlers(deps(workerSelf)).sendMessage({
			to: ['epic', 'pm'],
			text: 'nope'
		})
		expect(res).toEqual({ ok: false, reason: 'mixed_kind' })
		expect(createFileMailbox(home).poll('pm-2345')).toEqual([])
	})

	it('a failing entry in a list writes nothing for any entry', async () => {
		seedSecondWorker()
		const res = await createHandlers(deps(pmSelf)).sendMessage({
			to: ['wkr-1234', 'no-such-peer'],
			text: 'nope'
		})
		expect(res).toEqual({ ok: false, reason: 'not_found' })
		expect(createFileMailbox(home).poll('wkr-1234')).toEqual([])
		expect(createFileMailbox(home).poll('wkr-9999')).toEqual([])
	})

	it('two separate sends to the same peer still carry distinct ids', async () => {
		const h = createHandlers(deps(workerSelf))
		await h.sendMessage({ to: 'pm', text: 'one' })
		await h.sendMessage({ to: 'pm', text: 'two' })
		const got = createFileMailbox(home).poll('pm-2345')
		expect(got).toHaveLength(2)
		expect(got[0].id).not.toBe(got[1].id)
	})
})

describe('sendMessage thread argument', () => {
	it('attaches a handle selector to every written copy', async () => {
		seedSecondWorker()
		const res = await createHandlers(deps(pmSelf)).sendMessage({
			to: 'epic',
			text: 'in the rollout thread',
			thread: 't_9f2a'
		})
		expect(res).toMatchObject({ ok: true, count: 2 })

		const a = createFileMailbox(home).poll('wkr-1234')
		const b = createFileMailbox(home).poll('wkr-9999')
		expect(a[0].thread).toEqual({ kind: 'handle', handle: 't_9f2a' })
		expect(b[0].thread).toEqual({ kind: 'handle', handle: 't_9f2a' })
	})

	it('attaches a new-thread selector carrying its title', async () => {
		await createHandlers(deps(workerSelf)).sendMessage({
			to: 'pm',
			text: 'starting something',
			thread: { new: 'rollout plan' }
		})
		const got = createFileMailbox(home).poll('pm-2345')
		expect(got[0].thread).toEqual({ kind: 'new', title: 'rollout plan' })
	})

	it('writes no thread selector when the argument is omitted', async () => {
		await createHandlers(deps(workerSelf)).sendMessage({ to: 'pm', text: 'plain' })
		expect(createFileMailbox(home).poll('pm-2345')[0].thread).toBeUndefined()
	})

	it('does not alter local delivery or the channel meta a recipient sees', async () => {
		const h = createHandlers(deps(workerSelf))
		await h.sendMessage({ to: 'pm', text: 'threaded', thread: 't_9f2a' })
		await h.sendMessage({ to: 'pm', text: 'threaded' })
		const got = createFileMailbox(home).poll('pm-2345')
		expect(got).toHaveLength(2)
		const [withThread, without] = got
		expect(withThread.text).toBe('threaded')
		const threaded = buildChannelNotification(withThread)
		const plain = buildChannelNotification(without)
		expect(threaded.content).toBe(plain.content)
		// Same keys, same values — bar the id, which differs between any two sends.
		expect(Object.keys(threaded.meta).sort()).toEqual(Object.keys(plain.meta).sort())
		expect({ ...threaded.meta, msg_id: '' }).toEqual({ ...plain.meta, msg_id: '' })
	})

	it('fails with invalid_thread and writes nothing when the handle is malformed', async () => {
		// Shape needs no lookup, so this holds in every transport, wired seam or not.
		for (const bad of ['not a handle', '', 't_', 'x_9f2a', 't_9f 2a', '9f2a']) {
			const res = await createHandlers(deps(workerSelf)).sendMessage({
				to: 'pm',
				text: 'typo',
				thread: bad
			})
			expect(res).toEqual({ ok: false, reason: 'invalid_thread' })
		}
		expect(createFileMailbox(home).poll('pm-2345')).toEqual([])
	})

	it('rejects a malformed handle before ever consulting thread state', async () => {
		const knowsThread = vi.fn().mockReturnValue(true)
		const res = await createHandlers({ ...deps(workerSelf), knowsThread }).sendMessage({
			to: 'pm',
			text: 'typo',
			thread: 'not a handle'
		})
		expect(res).toEqual({ ok: false, reason: 'invalid_thread' })
		expect(knowsThread).not.toHaveBeenCalled()
	})

	it('accepts the handle shapes the bridge actually mints', async () => {
		for (const good of ['t_9f2a', 't_0a1b2c3d', 't_rs-37697c5f']) {
			const res = await createHandlers(deps(workerSelf)).sendMessage({
				to: 'pm',
				text: 'ok',
				thread: good
			})
			expect(res).toMatchObject({ ok: true })
		}
	})

	it('writes the message when no seam can resolve the handle, leaving the mirror to cope', async () => {
		// The socket transport cannot answer a lookup synchronously. Local delivery is not held
		// hostage to that; the mirror posts to the main timeline and logs the mismatch.
		const res = await createHandlers(deps(workerSelf)).sendMessage({
			to: 'pm',
			text: 'still delivered',
			thread: 't_doesnotexist'
		})
		expect(res).toMatchObject({ ok: true, count: 1 })
		const got = createFileMailbox(home).poll('pm-2345')
		expect(got).toHaveLength(1)
		expect(got[0].thread).toEqual({ kind: 'handle', handle: 't_doesnotexist' })
	})

	it('fails with thread_not_found and writes nothing when the handle is unknown', async () => {
		const res = await createHandlers({
			...deps(workerSelf),
			knowsThread: (handle) => handle === 't_9f2a'
		}).sendMessage({ to: 'pm', text: 'typo', thread: 't_doesnotexist' })

		expect(res).toEqual({ ok: false, reason: 'thread_not_found' })
		expect(createFileMailbox(home).poll('pm-2345')).toEqual([])
	})

	it('writes normally when the handle is known', async () => {
		const res = await createHandlers({
			...deps(workerSelf),
			knowsThread: (handle) => handle === 't_9f2a'
		}).sendMessage({ to: 'pm', text: 'ok', thread: 't_9f2a' })

		expect(res).toMatchObject({ ok: true, count: 1 })
		expect(createFileMailbox(home).poll('pm-2345')).toHaveLength(1)
	})

	it('never checks a new-thread selector against known handles', async () => {
		const knowsThread = vi.fn().mockReturnValue(false)
		const res = await createHandlers({ ...deps(workerSelf), knowsThread }).sendMessage({
			to: 'pm',
			text: 'fresh',
			thread: { new: 'rollout plan' }
		})
		expect(res).toMatchObject({ ok: true })
		expect(knowsThread).not.toHaveBeenCalled()
	})

	it('checks the handle before resolving is even attempted, so a bad target still wins', async () => {
		// Resolution failure is reported ahead of thread validation: the caller learns about the
		// recipient they got wrong, which is the fault they can act on.
		const res = await createHandlers({
			...deps(workerSelf),
			knowsThread: () => false
		}).sendMessage({ to: 'nobody', text: 'x', thread: 't_nope' })
		expect(res).toEqual({ ok: false, reason: 'not_found' })
	})
})

describe('start -> inbound bridge', () => {
	it('delivers an incoming message to notify() as a channel event', async () => {
		const notify = vi.fn().mockResolvedValue(undefined)
		const pmHandlers = createHandlers(deps(pmSelf, notify))
		const stop = pmHandlers.start()

		// worker sends to the PM
		await createHandlers(deps(workerSelf)).sendMessage({ to: 'pm', text: 'ping' })

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
	it('maps content + meta', async () => {
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
	it('excludes a session that has a registry entry but no live beacon', async () => {
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

	it('excludes a session that has a beacon but no registry entry', async () => {
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

/** A transport that records what it was asked and answers with whatever a test sets. */
function bridgedDeps(
	self: PeerIdentity,
	over: {
		history?: HistoryResult
		reply?: MatrixReplyResult
	} = {}
): {
	deps: HandlerDeps
	asked: { history: HistoryQuery[]; replies: MatrixReplyRequest[] }
	sent: { to: string; msg: ChannelMessage }[]
} {
	const asked = { history: [] as HistoryQuery[], replies: [] as MatrixReplyRequest[] }
	const sent: { to: string; msg: ChannelMessage }[] = []
	const file = createFileMailbox(home)
	const transport: Transport = {
		send: (to, msg) => {
			sent.push({ to, msg })
			file.send(to, msg)
		},
		poll: (id) => file.poll(id),
		watch: (id, cb) => file.watch(id, cb),
		rekey: (id) => file.rekey(id),
		history: async (query) => {
			asked.history.push(query)
			return over.history ?? { ok: false, reason: 'unavailable' }
		},
		replyToHuman: async (req) => {
			asked.replies.push(req)
			return over.reply ?? { ok: false, reason: 'unavailable' }
		}
	}
	return { deps: { ...deps(self), transport }, asked, sent }
}

describe('read_history', () => {
	it('returns what the transport answered, unchanged', async () => {
		const answer: HistoryResult = {
			ok: true,
			room: '!epic:host',
			messages: [
				{ from: 'Samer Z', from_id: '@samer:host', origin: 'human', text: 'ship it', at: 5 }
			],
			more: false
		}
		const { deps: d } = bridgedDeps(workerSelf, { history: answer })

		expect(await createHandlers(d).readHistory({})).toEqual(answer)
	})

	it('asks for the caller’s default room when given nothing', async () => {
		const { deps: d, asked } = bridgedDeps(workerSelf)
		await createHandlers(d).readHistory({})

		expect(asked.history).toEqual([{}])
	})

	it('forwards every argument it was given', async () => {
		const { deps: d, asked } = bridgedDeps(workerSelf)
		await createHandlers(d).readHistory({
			room: '!other:host',
			thread: 't_9f2a',
			since: 's-1',
			limit: 5,
			search: 'beacon'
		})

		expect(asked.history).toEqual([
			{ room: '!other:host', thread: 't_9f2a', since: 's-1', limit: 5, search: 'beacon' }
		])
	})

	it('answers unavailable on the flat-file transport without throwing', async () => {
		const h = createHandlers(deps(workerSelf))

		await expect(h.readHistory({})).resolves.toEqual({ ok: false, reason: 'unavailable' })
	})

	it('answers unavailable when the bridge is disabled behind the socket', async () => {
		const { deps: d } = bridgedDeps(workerSelf, { history: { ok: false, reason: 'unavailable' } })

		await expect(createHandlers(d).readHistory({})).resolves.toEqual({
			ok: false,
			reason: 'unavailable'
		})
	})
})

describe('send_message addressed to a person', () => {
	it('posts to Matrix and reports the destination room and thread', async () => {
		const { deps: d, asked } = bridgedDeps(workerSelf, {
			reply: { ok: true, room: '!epic:host', thread: 't_9f2a' }
		})

		const res = await createHandlers(d).sendMessage({ to: '@samer:host', text: 'on it' })

		expect(res).toEqual({
			ok: true,
			kind: 'matrix',
			to: '@samer:host',
			room: '!epic:host',
			thread: 't_9f2a'
		})
		expect(asked.replies).toEqual([{ to: '@samer:host', text: 'on it' }])
	})

	it('reports a destination with no thread when the reply landed on the timeline', async () => {
		const { deps: d } = bridgedDeps(workerSelf, { reply: { ok: true, room: '!lobby:host' } })

		const res = await createHandlers(d).sendMessage({ to: '@samer:host', text: 'on it' })

		expect(res).toEqual({ ok: true, kind: 'matrix', to: '@samer:host', room: '!lobby:host' })
	})

	it('writes no local inbox and wakes no peer', async () => {
		const { deps: d, sent } = bridgedDeps(workerSelf, { reply: { ok: true, room: '!epic:host' } })
		const before = readdirSync(home)

		await createHandlers(d).sendMessage({ to: '@samer:host', text: 'on it' })

		expect(sent).toEqual([])
		expect(readdirSync(home)).toEqual(before)
	})

	it('answers unavailable with no bridge, and still writes nothing', async () => {
		const { deps: d, sent } = bridgedDeps(workerSelf)

		const res = await createHandlers(d).sendMessage({ to: '@samer:host', text: 'on it' })

		expect(res).toEqual({ ok: false, reason: 'unavailable' })
		expect(sent).toEqual([])
	})

	it('answers unavailable on the flat-file transport', async () => {
		const res = await createHandlers(deps(workerSelf)).sendMessage({
			to: '@samer:host',
			text: 'on it'
		})

		expect(res).toEqual({ ok: false, reason: 'unavailable' })
	})

	it('resolves a namespace target by the local rules instead', async () => {
		const { deps: d, asked } = bridgedDeps(workerSelf)

		const res = await createHandlers(d).sendMessage({ to: '@cc.proj.pm.42:host', text: 'hi' })

		// Not a Matrix reply: a namespace user is a session, and sessions are reached locally —
		// where this name resolves to nobody, which is a local not_found rather than a post.
		expect(asked.replies).toEqual([])
		expect(res).toMatchObject({ ok: false })
		expect(res.ok === false && res.reason).not.toBe('unavailable')
	})

	it('leaves local messaging alone while the bridge is unavailable', async () => {
		const { deps: d, sent } = bridgedDeps(workerSelf)

		const res = await createHandlers(d).sendMessage({ to: 'pm', text: 'still works' })

		expect(res).toMatchObject({ ok: true, count: 1 })
		expect(sent.map((s) => s.to)).toEqual(['pm-2345'])
	})

	it('treats a list containing a Matrix id as a local address', async () => {
		const { deps: d, asked } = bridgedDeps(workerSelf)

		await createHandlers(d).sendMessage({ to: ['@samer:host'], text: 'hi' })

		expect(asked.replies).toEqual([])
	})

	it('is not fooled by a name that merely contains an at sign', async () => {
		const { deps: d, asked } = bridgedDeps(workerSelf)

		await createHandlers(d).sendMessage({ to: 'the @samer session', text: 'hi' })

		expect(asked.replies).toEqual([])
	})
})
