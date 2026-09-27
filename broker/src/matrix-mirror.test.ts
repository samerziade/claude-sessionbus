import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelMessage, ThreadSelector } from '../../bus/src/message.ts'
import {
	createMatrixMirror,
	type MirrorDeps,
	type MirrorIdentity,
	type MirrorPost,
	type MirrorThreads,
	newThreadHandle,
	type PostOutcome,
	pairThreadHandle
} from './matrix-mirror.ts'

const EPIC_ROOM = '!epic42:hs'
const OTHER_EPIC_ROOM = '!epic57:hs'
const LOBBY = '!lobby:hs'
const OTHER_LOBBY = '!other-lobby:hs'

const PM: MirrorIdentity = { userId: '@cc.p.pm.42:hs', epicRoomId: EPIC_ROOM, lobbyRoomId: LOBBY }
const WORKER: MirrorIdentity = {
	userId: '@cc.p.w.123:hs',
	epicRoomId: EPIC_ROOM,
	lobbyRoomId: LOBBY
}
const WORKER_2: MirrorIdentity = {
	userId: '@cc.p.w.456:hs',
	epicRoomId: EPIC_ROOM,
	lobbyRoomId: LOBBY
}
/** Same project, a different epic: shares the lobby but no epic room. */
const STRANGER: MirrorIdentity = {
	userId: '@cc.p.w.999:hs',
	epicRoomId: OTHER_EPIC_ROOM,
	lobbyRoomId: LOBBY
}
/** Another project entirely: shares nothing. */
const FOREIGNER: MirrorIdentity = {
	userId: '@cc.q.w.1:hs',
	epicRoomId: undefined,
	lobbyRoomId: OTHER_LOBBY
}

const DIRECTORY: Record<string, MirrorIdentity> = {
	pm: PM,
	worker: WORKER,
	worker2: WORKER_2,
	stranger: STRANGER,
	foreigner: FOREIGNER
}

interface Sent {
	posts: MirrorPost[]
	/** Outcomes to serve, oldest first; anything past the end succeeds. */
	outcomes: PostOutcome[]
	throwOnce: boolean
}

function msg(over: Partial<ChannelMessage> = {}): ChannelMessage {
	return {
		id: 'm1',
		from: { sessionId: 'worker', name: '123 epic:42', epic: '42', role: 'worker' },
		to: { kind: 'session', value: 'pm' },
		text: 'status update',
		createdAt: 1,
		...over
	}
}

function fakeThreads(): MirrorThreads & {
	roots: Map<string, string>
	lastHeard: Map<string, string>
} {
	const roots = new Map<string, string>()
	const lastHeard = new Map<string, string>()
	return {
		roots,
		lastHeard,
		resolve: (handle) => roots.get(handle),
		remember: (handle, rootEventId) => {
			roots.set(handle, rootEventId)
		},
		lastThreadWith: (self, peer) => lastHeard.get(`${self}|${peer}`)
	}
}

interface Harness {
	deps: MirrorDeps
	sent: Sent
	threads: ReturnType<typeof fakeThreads>
	logs: string[]
	/** Event id handed back for the next successful post. */
	nextEventId: () => string
}

function harness(over: Partial<MirrorDeps> = {}): Harness {
	const sent: Sent = { posts: [], outcomes: [], throwOnce: false }
	const threads = fakeThreads()
	const logs: string[] = []
	let events = 0
	const nextEventId = () => `$event-${events}`
	const deps: MirrorDeps = {
		identify: (sessionId) => DIRECTORY[sessionId],
		post: async (post) => {
			sent.posts.push(post)
			if (sent.throwOnce) {
				sent.throwOnce = false
				throw new Error('the homeserver hung up')
			}
			const outcome = sent.outcomes.shift()
			if (outcome !== undefined) return outcome
			events += 1
			return { ok: true, eventId: nextEventId() }
		},
		threads,
		random: () => 1,
		log: (m) => logs.push(m),
		...over
	}
	return { deps, sent, threads, logs, nextEventId }
}

/** The transaction ids of the message posts, leaving out the roots that opened threads. */
function messageTxnIds(h: Harness): string[] {
	return h.sent.posts.filter((p) => !p.txnId.endsWith(':root')).map((p) => p.txnId)
}

/** Let every already-resolved post promise settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('pairThreadHandle', () => {
	it('is the same whichever way round the pair is named', () => {
		expect(pairThreadHandle(EPIC_ROOM, PM.userId, WORKER.userId)).toBe(
			pairThreadHandle(EPIC_ROOM, WORKER.userId, PM.userId)
		)
	})

	it('differs per room, so one pair has a thread in each room they share', () => {
		expect(pairThreadHandle(EPIC_ROOM, PM.userId, WORKER.userId)).not.toBe(
			pairThreadHandle(LOBBY, PM.userId, WORKER.userId)
		)
	})

	it('differs per pair', () => {
		expect(pairThreadHandle(EPIC_ROOM, PM.userId, WORKER.userId)).not.toBe(
			pairThreadHandle(EPIC_ROOM, PM.userId, WORKER_2.userId)
		)
	})
})

describe('dedupe by message id', () => {
	it('enqueues one job however many recipients a fan-out routed to', async () => {
		const h = harness()
		const mirror = createMatrixMirror(h.deps)
		const broadcast = msg({
			id: 'b1',
			from: { sessionId: 'pm', name: 'epic:42', epic: '42', role: 'pm' },
			to: { kind: 'epic', value: 'epic' }
		})

		mirror.onRouted(broadcast)
		mirror.onRouted(broadcast)
		mirror.onRouted(broadcast)
		await settle()

		expect(h.sent.posts).toHaveLength(1)
	})

	it('enqueues one job per distinct id for two identical sends', async () => {
		const h = harness()
		const mirror = createMatrixMirror(h.deps)
		mirror.onRouted(msg({ id: 'm1', text: 'ping' }))
		mirror.onRouted(msg({ id: 'm2', text: 'ping' }))
		await settle()

		expect(messageTxnIds(h)).toEqual(['m1', 'm2'])
	})

	it('mirrors nothing when route() was never called', async () => {
		// The bus-side half of this — a broadcast with no live members routing nothing at all —
		// is asserted in bus/src/handlers.test.ts, which is where it is observable.
		const h = harness()
		createMatrixMirror(h.deps)
		await settle()
		expect(h.sent.posts).toEqual([])
	})

	it('forgets the oldest ids once the window is full, and never re-posts a live one', async () => {
		const h = harness()
		const mirror = createMatrixMirror({ ...h.deps, seenWindow: 2 })
		mirror.onRouted(msg({ id: 'a' }))
		mirror.onRouted(msg({ id: 'b' }))
		mirror.onRouted(msg({ id: 'b' }))
		mirror.onRouted(msg({ id: 'c' })) // evicts 'a'
		mirror.onRouted(msg({ id: 'a' })) // no longer remembered: mirrored again
		await settle()

		expect(messageTxnIds(h)).toEqual(['a', 'b', 'c', 'a'])
	})
})

describe('room selection', () => {
	it('posts a direct message into the epic room the pair shares, mentioning the recipient', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(msg())
		await settle()

		expect(h.sent.posts.at(-1)).toMatchObject({
			roomId: EPIC_ROOM,
			asUser: WORKER.userId,
			text: 'status update',
			mentions: { userIds: [PM.userId], room: false }
		})
	})

	it("falls back to the sender's lobby when the pair share no epic room", async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(msg({ to: { kind: 'session', value: 'stranger' } }))
		await settle()

		expect(h.sent.posts.at(-1)).toMatchObject({
			roomId: LOBBY,
			mentions: { userIds: [STRANGER.userId], room: false }
		})
	})

	it("uses the sender's lobby for a recipient in another project", async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(msg({ to: { kind: 'session', value: 'foreigner' } }))
		await settle()

		expect(h.sent.posts.at(-1)).toMatchObject({ roomId: LOBBY })
	})

	it('posts an epic broadcast into the epic room, mentioning the whole room', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(
			msg({
				from: { sessionId: 'pm', name: 'epic:42', epic: '42', role: 'pm' },
				to: { kind: 'epic', value: 'epic' },
				text: 'standup in 5'
			})
		)
		await settle()

		expect(h.sent.posts.at(-1)).toMatchObject({
			roomId: EPIC_ROOM,
			asUser: PM.userId,
			text: 'standup in 5',
			mentions: { userIds: [], room: true }
		})
	})

	it('posts once into the shared epic room for a list to, mentioning each recipient', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(
			msg({
				from: { sessionId: 'pm', name: 'epic:42', epic: '42', role: 'pm' },
				to: { kind: 'session', value: 'worker', recipients: ['worker', 'worker2'] }
			})
		)
		await settle()

		expect(h.sent.posts).toHaveLength(1)
		expect(h.sent.posts[0]).toMatchObject({
			roomId: EPIC_ROOM,
			mentions: { userIds: [WORKER.userId, WORKER_2.userId], room: false }
		})
	})

	it("posts a mixed list to into the sender's lobby, mentioning each recipient", async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(
			msg({
				from: { sessionId: 'pm', name: 'epic:42', epic: '42', role: 'pm' },
				to: { kind: 'session', value: 'worker', recipients: ['worker', 'stranger'] }
			})
		)
		await settle()

		expect(h.sent.posts).toHaveLength(1)
		expect(h.sent.posts[0]).toMatchObject({
			roomId: LOBBY,
			mentions: { userIds: [WORKER.userId, STRANGER.userId], room: false }
		})
	})

	it('drops a message whose sender has no remote identity, and says so', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(
			msg({ from: { sessionId: 'unprovisioned', name: 'x', role: 'none' } })
		)
		await settle()

		expect(h.sent.posts).toEqual([])
		expect(h.logs.join('\n')).toContain('m1')
	})

	it('still posts when a recipient has no remote identity, mentioning only the known ones', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(
			msg({ to: { kind: 'session', value: 'pm', recipients: ['pm', 'unprovisioned'] } })
		)
		await settle()

		expect(h.sent.posts.at(-1)).toMatchObject({
			roomId: LOBBY, // an unknown recipient shares no room by construction
			mentions: { userIds: [PM.userId], room: false }
		})
	})

	it('drops an epic broadcast from a sender with no epic room rather than mentioning a lobby', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(
			msg({
				from: { sessionId: 'foreigner', name: 'x', role: 'none' },
				to: { kind: 'epic', value: 'epic' }
			})
		)
		await settle()

		expect(h.sent.posts).toEqual([])
		expect(h.logs.join('\n')).toMatch(/epic room/i)
	})

	it('drops a message when the sender has neither a shared room nor a lobby', async () => {
		const h = harness({
			identify: (sessionId) =>
				sessionId === 'worker' ? { userId: WORKER.userId } : DIRECTORY[sessionId]
		})
		createMatrixMirror(h.deps).onRouted(msg())
		await settle()

		expect(h.sent.posts).toEqual([])
		expect(h.logs).not.toEqual([])
	})
})

describe('pair threads', () => {
	it('creates a pair thread on the first direct message and posts into it', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(msg())
		await settle()

		expect(h.sent.posts).toHaveLength(2)
		const [root, message] = h.sent.posts
		expect(root.threadRootEventId).toBeUndefined()
		expect(root.roomId).toBe(EPIC_ROOM)
		expect(message.threadRootEventId).toBe('$event-1')
		expect(h.threads.roots.get(pairThreadHandle(EPIC_ROOM, WORKER.userId, PM.userId))).toBe(
			'$event-1'
		)
	})

	it('reuses the pair thread for a later message between the same pair', async () => {
		const h = harness()
		const mirror = createMatrixMirror(h.deps)
		mirror.onRouted(msg({ id: 'm1' }))
		await settle()
		mirror.onRouted(msg({ id: 'm2' }))
		await settle()

		expect(h.sent.posts).toHaveLength(3) // one root, two messages
		expect(h.sent.posts[2].threadRootEventId).toBe(h.sent.posts[1].threadRootEventId)
	})

	it('reuses the pair thread whichever direction the message goes', async () => {
		const h = harness()
		const mirror = createMatrixMirror(h.deps)
		mirror.onRouted(msg({ id: 'm1' }))
		await settle()
		mirror.onRouted(
			msg({
				id: 'm2',
				from: { sessionId: 'pm', name: 'epic:42', epic: '42', role: 'pm' },
				to: { kind: 'session', value: 'worker' }
			})
		)
		await settle()

		expect(h.sent.posts).toHaveLength(3)
		expect(h.sent.posts[2].threadRootEventId).toBe(h.sent.posts[1].threadRootEventId)
	})

	it('gives a worker-to-worker pair a thread of its own', async () => {
		const h = harness()
		const mirror = createMatrixMirror(h.deps)
		mirror.onRouted(msg({ id: 'm1' })) // worker -> pm
		await settle()
		mirror.onRouted(msg({ id: 'm2', to: { kind: 'session', value: 'worker2' } }))
		await settle()

		const withPm = h.threads.roots.get(pairThreadHandle(EPIC_ROOM, WORKER.userId, PM.userId))
		const withPeer = h.threads.roots.get(
			pairThreadHandle(EPIC_ROOM, WORKER.userId, WORKER_2.userId)
		)
		expect(withPm).toBeDefined()
		expect(withPeer).toBeDefined()
		expect(withPm).not.toBe(withPeer)
	})

	it('adopts a pair thread bridge state already knows, creating no root', async () => {
		const h = harness()
		h.threads.remember(pairThreadHandle(EPIC_ROOM, WORKER.userId, PM.userId), '$already-there')
		createMatrixMirror(h.deps).onRouted(msg())
		await settle()

		expect(h.sent.posts).toHaveLength(1)
		expect(h.sent.posts[0].threadRootEventId).toBe('$already-there')
	})

	it('reuses a pair thread across a broker restart, since the handle is derived', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(msg({ id: 'before' }))
		await settle()
		const root = h.sent.posts[1].threadRootEventId

		// A restart: new mirror, new queues, new dedupe window — the same durable thread state.
		const restarted = createMatrixMirror({ ...h.deps, threads: h.threads })
		restarted.onRouted(msg({ id: 'after' }))
		await settle()

		expect(h.sent.posts).toHaveLength(3) // no second root
		expect(h.sent.posts[2].threadRootEventId).toBe(root)
	})

	it('resolves the same handle to the same thread on either side of a restart', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(msg({ id: 'm1', thread: { kind: 'new', title: 'plan' } }))
		await settle()
		const handle = newThreadHandle('m1')
		const root = h.threads.resolve(handle)
		expect(root).toBeDefined()

		const restarted = createMatrixMirror({ ...h.deps, threads: h.threads })
		restarted.onRouted(msg({ id: 'm2', thread: { kind: 'handle', handle } }))
		await settle()

		expect(h.sent.posts.at(-1)).toMatchObject({ txnId: 'm2', threadRootEventId: root })
	})

	it('leaves an epic broadcast on the main timeline', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(
			msg({
				from: { sessionId: 'pm', name: 'epic:42', epic: '42', role: 'pm' },
				to: { kind: 'epic', value: 'epic' }
			})
		)
		await settle()

		expect(h.sent.posts).toHaveLength(1)
		expect(h.sent.posts[0].threadRootEventId).toBeUndefined()
	})

	it('leaves a multi-recipient send on the main timeline: a group is no pair', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(
			msg({ to: { kind: 'session', value: 'pm', recipients: ['pm', 'worker2'] } })
		)
		await settle()

		expect(h.sent.posts).toHaveLength(1)
		expect(h.sent.posts[0].threadRootEventId).toBeUndefined()
	})
})

describe('thread selection from the message', () => {
	const threaded = (thread: ThreadSelector, over: Partial<ChannelMessage> = {}) =>
		msg({ thread, ...over })

	it('posts into the thread an explicit handle resolves to', async () => {
		const h = harness()
		h.threads.remember('t_9f2a', '$root-9f2a')
		createMatrixMirror(h.deps).onRouted(threaded({ kind: 'handle', handle: 't_9f2a' }))
		await settle()

		expect(h.sent.posts).toHaveLength(1)
		expect(h.sent.posts[0].threadRootEventId).toBe('$root-9f2a')
	})

	it('posts an unresolvable handle to the main timeline and logs the mismatch', async () => {
		// The sender's transport could not check the handle before writing, and the message has
		// already been delivered locally. Dropping the mirror would leave a hole nobody can see.
		const h = harness()
		createMatrixMirror(h.deps).onRouted(threaded({ kind: 'handle', handle: 't_nope' }))
		await settle()

		expect(h.sent.posts).toHaveLength(1)
		expect(h.sent.posts[0]).toMatchObject({ txnId: 'm1', roomId: EPIC_ROOM })
		expect(h.sent.posts[0].threadRootEventId).toBeUndefined()
		expect(h.logs.join('\n')).toContain('t_nope')
	})

	it('never substitutes the pair thread for an unresolvable handle', async () => {
		// The neutral timeline is the fallback; the pair thread is a different conversation, and
		// putting the message there would be the silent redirection this refuses to do.
		const h = harness()
		createMatrixMirror(h.deps).onRouted(threaded({ kind: 'handle', handle: 't_nope' }))
		await settle()

		expect(h.threads.roots.size).toBe(0)
		expect(h.sent.posts.every((p) => p.threadRootEventId === undefined)).toBe(true)
	})

	it('falls back to the timeline when a handle stops resolving between planning and posting', async () => {
		// Resolves once, while the job is planned, and not again once it is attempted — the
		// state was rewritten under us in between.
		let answers = 0
		const h = harness()
		const threads: MirrorThreads = {
			resolve: (handle) => {
				answers += 1
				return handle === 't_9f2a' && answers === 1 ? '$root-9f2a' : undefined
			},
			remember: () => {}
		}
		createMatrixMirror({ ...h.deps, threads }).onRouted(
			threaded({ kind: 'handle', handle: 't_9f2a' })
		)
		await settle()

		expect(answers).toBeGreaterThan(1) // the attempt really did look it up again
		expect(h.sent.posts).toHaveLength(1)
		expect(h.sent.posts[0].threadRootEventId).toBeUndefined()
		expect(h.logs.join('\n')).toContain('no longer resolves')
	})

	it('still mirrors an unresolvable handle addressed to a whole room', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(
			msg({
				from: { sessionId: 'pm', name: 'epic:42', epic: '42', role: 'pm' },
				to: { kind: 'epic', value: 'epic' },
				thread: { kind: 'handle', handle: 't_nope' }
			})
		)
		await settle()

		expect(h.sent.posts).toHaveLength(1)
		expect(h.sent.posts[0]).toMatchObject({
			roomId: EPIC_ROOM,
			mentions: { userIds: [], room: true }
		})
		expect(h.sent.posts[0].threadRootEventId).toBeUndefined()
	})

	it('creates a titled root for a new-thread selector and posts into it', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(threaded({ kind: 'new', title: 'rollout plan' }))
		await settle()

		expect(h.sent.posts).toHaveLength(2)
		expect(h.sent.posts[0].text).toBe('rollout plan')
		expect(h.sent.posts[1].threadRootEventId).toBe('$event-1')
	})

	it('remembers a new thread under a handle that resolves to it afterwards', async () => {
		const h = harness()
		const mirror = createMatrixMirror(h.deps)
		mirror.onRouted(threaded({ kind: 'new', title: 'rollout plan' }, { id: 'm1' }))
		await settle()

		const handle = [...h.threads.roots.keys()].find((k) => h.threads.roots.get(k) === '$event-1')
		expect(handle).toBeDefined()
		if (handle === undefined) return

		mirror.onRouted(threaded({ kind: 'handle', handle }, { id: 'm2' }))
		await settle()
		expect(h.sent.posts.at(-1)).toMatchObject({ txnId: 'm2', threadRootEventId: '$event-1' })
	})

	it('answers in the thread the recipient was last heard in when none is given', async () => {
		const h = harness()
		h.threads.lastHeard.set(`${WORKER.userId}|${PM.userId}`, '$root-heard')
		createMatrixMirror(h.deps).onRouted(msg())
		await settle()

		expect(h.sent.posts).toHaveLength(1) // no pair root needed
		expect(h.sent.posts[0].threadRootEventId).toBe('$root-heard')
	})

	it('prefers an explicit handle over the thread the recipient was last heard in', async () => {
		const h = harness()
		h.threads.lastHeard.set(`${WORKER.userId}|${PM.userId}`, '$root-heard')
		h.threads.remember('t_9f2a', '$root-9f2a')
		createMatrixMirror(h.deps).onRouted(threaded({ kind: 'handle', handle: 't_9f2a' }))
		await settle()

		expect(h.sent.posts[0].threadRootEventId).toBe('$root-9f2a')
	})

	it('falls back to the pair thread when the pair have never been heard from', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(msg())
		await settle()

		expect(h.sent.posts).toHaveLength(2)
		expect(h.sent.posts[1].threadRootEventId).toBe('$event-1')
	})

	it('works without a last-heard source at all', async () => {
		const h = harness()
		const threads: MirrorThreads = {
			resolve: h.threads.resolve,
			remember: h.threads.remember
		}
		createMatrixMirror({ ...h.deps, threads }).onRouted(msg())
		await settle()

		expect(h.sent.posts).toHaveLength(2)
	})
})

describe('queue ordering, retry and bounds', () => {
	it('attempts jobs for one room in the order they were enqueued', async () => {
		const h = harness()
		const mirror = createMatrixMirror(h.deps)
		mirror.onRouted(
			msg({
				id: 'm1',
				to: { kind: 'epic', value: 'epic' },
				from: { sessionId: 'pm', name: 'epic:42', epic: '42', role: 'pm' }
			})
		)
		mirror.onRouted(
			msg({
				id: 'm2',
				to: { kind: 'epic', value: 'epic' },
				from: { sessionId: 'pm', name: 'epic:42', epic: '42', role: 'pm' }
			})
		)
		await settle()

		expect(h.sent.posts.map((p) => p.txnId)).toEqual(['m1', 'm2'])
	})

	it('retries a failed post with capped exponential backoff and jitter', async () => {
		const h = harness({ random: () => 0.5 })
		h.sent.outcomes = [{ ok: false }, { ok: false }]
		const mirror = createMatrixMirror({
			...h.deps,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		mirror.onRouted(msg())
		await settle()
		expect(h.sent.posts).toHaveLength(1)

		// 1000ms base, halved by the jitter source
		await vi.advanceTimersByTimeAsync(499)
		expect(h.sent.posts).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(h.sent.posts).toHaveLength(2)

		// second attempt failed too: the delay doubles
		await vi.advanceTimersByTimeAsync(999)
		expect(h.sent.posts).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(h.sent.posts).toHaveLength(3)
	})

	it('honours a retry-after longer than the backoff it computed', async () => {
		const h = harness({ random: () => 1 })
		h.sent.outcomes = [{ ok: false, retryAfterMs: 5_000 }]
		const mirror = createMatrixMirror({
			...h.deps,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		mirror.onRouted(msg())
		await settle()

		await vi.advanceTimersByTimeAsync(4_999)
		expect(h.sent.posts).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(h.sent.posts).toHaveLength(2)
	})

	it('caps the backoff near a minute however long the outage lasts', async () => {
		const h = harness({ random: () => 1 })
		h.sent.outcomes = Array.from({ length: 12 }, () => ({ ok: false }) as PostOutcome)
		const mirror = createMatrixMirror({
			...h.deps,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		mirror.onRouted(msg())
		await settle()

		// Ten minutes of retries: uncapped doubling would have reached ~17 minutes by attempt 11.
		await vi.advanceTimersByTimeAsync(10 * 60_000)
		expect(h.sent.posts.length).toBeGreaterThanOrEqual(12)
		expect(h.sent.posts.every((p) => p.txnId === 'm1')).toBe(true)
	})

	it('keeps a failed job queued rather than discarding it', async () => {
		const h = harness()
		h.sent.outcomes = [{ ok: false }]
		const mirror = createMatrixMirror({
			...h.deps,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		mirror.onRouted(msg())
		await settle()
		expect(mirror.queuedFor(EPIC_ROOM)).toBe(1)

		await vi.advanceTimersByTimeAsync(60_000)
		expect(h.sent.posts).toHaveLength(2)
		expect(mirror.queuedFor(EPIC_ROOM)).toBe(0)
	})

	it('treats a thrown post exactly as a failed one', async () => {
		const h = harness()
		h.sent.throwOnce = true
		const mirror = createMatrixMirror({
			...h.deps,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		mirror.onRouted(msg())
		await settle()
		expect(h.sent.posts).toHaveLength(1)

		await vi.advanceTimersByTimeAsync(60_000)
		expect(h.sent.posts).toHaveLength(2)
	})

	it('lets a job for another room through while one room is retrying', async () => {
		const h = harness()
		h.sent.outcomes = [{ ok: false }]
		const mirror = createMatrixMirror({
			...h.deps,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		mirror.onRouted(msg({ id: 'stuck' })) // epic room
		await settle()
		mirror.onRouted(msg({ id: 'free', to: { kind: 'session', value: 'stranger' } })) // lobby
		await settle()

		expect(h.sent.posts.map((p) => p.txnId)).toEqual(['stuck', 'free'])
		expect(mirror.queuedFor(EPIC_ROOM)).toBe(1)
		expect(mirror.queuedFor(LOBBY)).toBe(0)
	})

	it('holds a later job for the same room behind the one retrying', async () => {
		const h = harness()
		h.sent.outcomes = [{ ok: false }]
		const mirror = createMatrixMirror({
			...h.deps,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		mirror.onRouted(msg({ id: 'first' }))
		await settle()
		mirror.onRouted(msg({ id: 'second' }))
		await settle()

		expect(h.sent.posts.map((p) => p.txnId)).toEqual(['first'])
		await vi.advanceTimersByTimeAsync(60_000)
		expect(h.sent.posts.map((p) => p.txnId)).toEqual(['first', 'first', 'second'])
	})

	it('drops the oldest waiting job when a room is at capacity, and logs it', async () => {
		const h = harness()
		h.sent.outcomes = [{ ok: false }]
		const mirror = createMatrixMirror({
			...h.deps,
			maxQueuePerRoom: 2,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		mirror.onRouted(msg({ id: 'stuck' }))
		await settle()
		mirror.onRouted(msg({ id: 'waiting' }))
		mirror.onRouted(msg({ id: 'newest' }))
		await settle()

		expect(mirror.queuedFor(EPIC_ROOM)).toBe(2)
		expect(h.logs.join('\n')).toMatch(/dropped/i)

		await vi.advanceTimersByTimeAsync(60_000)
		await settle()
		// 'waiting' was the oldest job not being attempted, so it is the one that went.
		expect(h.sent.posts.map((p) => p.txnId)).toEqual(['stuck', 'stuck', 'newest'])
	})

	it('keeps delivering to a room after an overflow', async () => {
		const h = harness()
		const mirror = createMatrixMirror({
			...h.deps,
			maxQueuePerRoom: 1,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		for (const id of ['a', 'b', 'c']) mirror.onRouted(msg({ id }))
		await settle()
		await vi.advanceTimersByTimeAsync(60_000)

		expect(h.sent.posts.length).toBeGreaterThan(0)
		expect(mirror.queuedFor(EPIC_ROOM)).toBe(0)
	})
})

describe('idempotent posting', () => {
	it('uses the message id as the transaction id', async () => {
		const h = harness()
		createMatrixMirror({
			...h.deps,
			threads: { resolve: () => '$root', remember: () => {} }
		}).onRouted(msg({ id: 'abc-123' }))
		await settle()

		expect(h.sent.posts[0].txnId).toBe('abc-123')
	})

	it('reuses that transaction id on every retry', async () => {
		const h = harness()
		h.sent.outcomes = [{ ok: false }, { ok: false }]
		const mirror = createMatrixMirror({
			...h.deps,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		mirror.onRouted(msg({ id: 'abc-123' }))
		await settle()
		await vi.advanceTimersByTimeAsync(120_000)

		expect(h.sent.posts).toHaveLength(3)
		expect(new Set(h.sent.posts.map((p) => p.txnId))).toEqual(new Set(['abc-123']))
	})

	it('gives two distinct messages two distinct transaction ids', async () => {
		const h = harness()
		const mirror = createMatrixMirror({
			...h.deps,
			threads: { resolve: () => '$root', remember: () => {} }
		})
		mirror.onRouted(msg({ id: 'm1' }))
		mirror.onRouted(msg({ id: 'm2' }))
		await settle()

		expect(h.sent.posts.map((p) => p.txnId)).toEqual(['m1', 'm2'])
	})

	it('creates no second root when the message post fails after the root succeeded', async () => {
		const h = harness()
		h.sent.outcomes = [{ ok: true, eventId: '$root-1' }, { ok: false }]
		const mirror = createMatrixMirror(h.deps)
		mirror.onRouted(msg())
		await settle()
		await vi.advanceTimersByTimeAsync(60_000)

		const roots = h.sent.posts.filter((p) => p.threadRootEventId === undefined)
		expect(roots).toHaveLength(1)
		expect(h.sent.posts.filter((p) => p.txnId === 'm1')).toHaveLength(2)
	})

	it('gives the root post its own transaction id, distinct from the message it opens', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(msg({ id: 'm1' }))
		await settle()

		const [root, message] = h.sent.posts
		expect(root.txnId).not.toBe(message.txnId)
		expect(root.txnId).toContain('m1')
	})

	it('posts as the sender, never as the bridge', async () => {
		const h = harness()
		createMatrixMirror(h.deps).onRouted(msg())
		await settle()

		expect(h.sent.posts.every((p) => p.asUser === WORKER.userId)).toBe(true)
	})
})

describe('failure containment', () => {
	it('never lets an identify that throws escape onRouted', async () => {
		const h = harness({
			identify: () => {
				throw new Error('directory is down')
			}
		})
		const mirror = createMatrixMirror(h.deps)
		expect(() => mirror.onRouted(msg())).not.toThrow()
		await settle()
		expect(h.logs).not.toEqual([])
	})

	it('never lets a thread lookup that throws escape onRouted', async () => {
		const h = harness({
			threads: {
				resolve: () => {
					throw new Error('state is unreadable')
				},
				remember: () => {}
			}
		})
		const mirror = createMatrixMirror(h.deps)
		expect(() => mirror.onRouted(msg())).not.toThrow()
		await settle()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(h.logs).not.toEqual([])
	})

	it('keeps mirroring later messages after one job is abandoned outright', async () => {
		const h = harness()
		const mirror = createMatrixMirror(h.deps)
		// No remote identity for the sender: nothing to post as, so the job never starts.
		mirror.onRouted(
			msg({ id: 'bad', from: { sessionId: 'unprovisioned', name: 'x', role: 'none' } })
		)
		await settle()
		mirror.onRouted(msg({ id: 'good' }))
		await settle()

		expect(h.sent.posts.some((p) => p.txnId === 'good')).toBe(true)
	})
})
