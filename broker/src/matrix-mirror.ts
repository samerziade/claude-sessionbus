import { createHash } from 'node:crypto'
import type { ChannelMessage } from '../../bus/src/message.ts'

/**
 * The outbound half of the bridge: routed traffic, mirrored into rooms so a person can read
 * what the sessions said to each other.
 *
 * Four properties carry the weight here:
 *
 * - **Mirroring is best-effort and local delivery is not.** Nothing in this module can delay,
 *   reorder or fail a `route()` call; it is handed messages after they have already been
 *   delivered or queued. A homeserver outage costs history, never delivery.
 * - **Nothing throws across the boundary.** The process hosting this turns an unhandled
 *   rejection into a non-zero exit, so a failing post must be a caught value — a single
 *   escaped rejection would make a homeserver outage a broker crash-loop.
 * - **One logical message becomes one event.** `onRouted` fires once per recipient, so a
 *   fan-out arrives here several times carrying one id; the first is mirrored and the rest are
 *   recognized and ignored. The message id is also the Matrix transaction id, so a post
 *   retried after a transient failure is the same event rather than a second one.
 * - **A thread is never guessed.** A handle that resolves to nothing puts the message on the
 *   room's main timeline and logs the mismatch — never on the pair thread or any other one. The
 *   message has already been delivered locally, so dropping its mirror would leave a hole nobody
 *   can see or recover; the timeline is not a wrong conversation, it is the neutral one, and a
 *   typo filed into a real discussion is the outcome this exists to prevent.
 */

/** Where one work identity can be reached remotely. */
export interface MirrorIdentity {
	/** The Matrix user this identity acts as. */
	userId: string
	/** The room for the grouping it belongs to, when it belongs to one. */
	epicRoomId?: string
	/** Its project lobby — the fallback room for anything the pair share no grouping for. */
	lobbyRoomId?: string
}

/** Who a post addresses: named users, or everyone in the room. */
export interface MirrorMentions {
	userIds: string[]
	room: boolean
}

export interface MirrorPost {
	roomId: string
	/** The identity the post is made as. Never the bridge's own user, which takes part in nothing. */
	asUser: string
	/** The message id, so a retried attempt is the same event rather than a second one. */
	txnId: string
	text: string
	mentions: MirrorMentions
	/** The thread this belongs in; absent means the room's main timeline. */
	threadRootEventId?: string
}

export type PostOutcome = { ok: true; eventId?: string } | { ok: false; retryAfterMs?: number }

/**
 * Thread bookkeeping, as this module needs it. Handle allocation and storage belong to the
 * durable state this is backed by; what matters here is that a handle resolves to one thread
 * root and keeps resolving to it.
 */
export interface MirrorThreads {
	/** The root event a handle names, or nothing when it names none. */
	resolve(handle: string): string | undefined
	/** Record a newly created thread under its handle. */
	remember(handle: string, rootEventId: string): void
	/**
	 * The thread `peerUserId` was most recently heard from in, when that is known. It is what
	 * keeps a session called into a discussion answering inside that discussion.
	 */
	lastThreadWith?(selfUserId: string, peerUserId: string): string | undefined
}

export interface MirrorDeps {
	/** The remote identity a session acts as, or nothing when it has none. */
	identify: (sessionId: string) => MirrorIdentity | undefined
	post: (post: MirrorPost) => Promise<PostOutcome>
	threads: MirrorThreads
	/** Jitter source in [0, 1); injected so a backoff sequence is exact in a test. */
	random: () => number
	log?: (msg: string) => void
	/** Jobs one room may hold before the oldest waiting one is dropped. */
	maxQueuePerRoom?: number
	/** How many recently mirrored ids are remembered for dedupe. */
	seenWindow?: number
}

export interface MatrixMirror {
	/** Wire this into `createBrokerCore`'s `onRouted`. */
	onRouted(msg: ChannelMessage): void
	/** Jobs a room still holds, attempted or waiting. Observability, not control. */
	queuedFor(roomId: string): number
}

const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
const DEFAULT_MAX_QUEUE_PER_ROOM = 100
const DEFAULT_SEEN_WINDOW = 1_000
/** 32 bits of SHA-256: short enough to read in a transcript, wide enough for one machine. */
const HANDLE_HEX_LENGTH = 8

/**
 * The handle of the thread a pair share in one room. Derived rather than allocated, and
 * order-independent, so both directions of a conversation name the same thread and a restart
 * re-derives it unchanged.
 */
export function pairThreadHandle(roomId: string, a: string, b: string): string {
	const [first, second] = a <= b ? [a, b] : [b, a]
	const digest = createHash('sha256')
		.update(`${roomId}\u0000${first}\u0000${second}`)
		.digest('hex')
		.slice(0, HANDLE_HEX_LENGTH)
	return `t_${digest}`
}

/** The handle a `{ new }` thread is filed under. Derived from the message that opened it. */
export function newThreadHandle(messageId: string): string {
	return `t_${messageId}`
}

/**
 * The handle naming a thread the bridge did not open — one a person started in a room. Derived
 * from the thread's root rather than allocated, so the same thread is named the same way on
 * every sighting and across a restart, and a transcript can refer to it without carrying a raw
 * event id.
 */
export function roomThreadHandle(roomId: string, rootEventId: string): string {
	const digest = createHash('sha256')
		.update(`${roomId}\u0000${rootEventId}`)
		.digest('hex')
		.slice(0, HANDLE_HEX_LENGTH)
	return `t_${digest}`
}

/** What the mirror decided to do with one message, before any of it is attempted. */
interface Job {
	messageId: string
	roomId: string
	asUser: string
	text: string
	mentions: MirrorMentions
	/** How the thread is chosen at attempt time; resolution can itself need a post. */
	thread: ThreadPlan
	attempts: number
}

type ThreadPlan =
	| { kind: 'timeline' }
	/** A root event known outright, with no handle to look up. */
	| { kind: 'root'; rootEventId: string }
	| { kind: 'handle'; handle: string }
	| { kind: 'ensure'; handle: string; title: string }

interface RoomQueue {
	jobs: Job[]
	/** True while the head job is being attempted or waiting to be retried. */
	busy: boolean
}

export function createMatrixMirror(deps: MirrorDeps): MatrixMirror {
	const log = deps.log ?? (() => {})
	const maxQueue = deps.maxQueuePerRoom ?? DEFAULT_MAX_QUEUE_PER_ROOM
	const seenWindow = deps.seenWindow ?? DEFAULT_SEEN_WINDOW
	const queues = new Map<string, RoomQueue>()
	// A bounded window, oldest evicted first. Bounded because this runs for weeks; the cost of
	// an eviction is one duplicate event, which the transaction id makes harmless anyway.
	const seen = new Set<string>()
	const seenOrder: string[] = []

	function remember(messageId: string): boolean {
		if (seen.has(messageId)) return false
		seen.add(messageId)
		seenOrder.push(messageId)
		while (seenOrder.length > seenWindow) {
			const evicted = seenOrder.shift()
			if (evicted !== undefined) seen.delete(evicted)
		}
		return true
	}

	/** Every session this message was addressed to, whether it fanned out or not. */
	function recipientsOf(msg: ChannelMessage): string[] {
		return msg.to.recipients ?? [msg.to.value]
	}

	/**
	 * Which room records this message, and who it names in it. A pair that shares a grouping is
	 * recorded where that grouping lives; anything else falls back to the sender's lobby, which
	 * is the one room the sender is certain to be in.
	 */
	function planRoom(
		msg: ChannelMessage,
		sender: MirrorIdentity
	): { roomId: string; mentions: MirrorMentions; recipients: MirrorIdentity[] } | undefined {
		if (msg.to.kind === 'epic') {
			// Addressed to a whole grouping, so only that grouping's room can carry it. Putting a
			// room-wide mention in the lobby instead would call on everyone in the project.
			if (sender.epicRoomId === undefined) {
				log(`mirror: dropping ${msg.id}: its sender has no epic room to broadcast into`)
				return undefined
			}
			return {
				roomId: sender.epicRoomId,
				mentions: { userIds: [], room: true },
				recipients: []
			}
		}

		const ids = recipientsOf(msg)
		const known: MirrorIdentity[] = []
		let allShareTheEpic = sender.epicRoomId !== undefined
		for (const sessionId of ids) {
			const identity = deps.identify(sessionId)
			// An identity we cannot name is one we cannot mention, and one we cannot place in a
			// room — so it counts against a shared room rather than being assumed into one.
			if (identity === undefined) {
				allShareTheEpic = false
				continue
			}
			known.push(identity)
			if (identity.epicRoomId !== sender.epicRoomId) allShareTheEpic = false
		}
		const mentions: MirrorMentions = { userIds: known.map((i) => i.userId), room: false }

		if (allShareTheEpic && sender.epicRoomId !== undefined) {
			return { roomId: sender.epicRoomId, mentions, recipients: known }
		}
		if (sender.lobbyRoomId !== undefined) {
			return { roomId: sender.lobbyRoomId, mentions, recipients: known }
		}
		log(
			`mirror: dropping ${msg.id}: its sender shares no room with the recipients and has no lobby`
		)
		return undefined
	}

	/**
	 * Which thread the message belongs in. An explicit selector wins; otherwise a direct message
	 * continues wherever the recipient was last heard, and failing that gets the pair's own
	 * thread. Anything addressed to more than one identity stays on the main timeline: a group
	 * is not a pair, and inventing a thread for it would bury the message.
	 */
	function planThread(
		msg: ChannelMessage,
		sender: MirrorIdentity,
		roomId: string,
		recipients: MirrorIdentity[]
	): ThreadPlan | undefined {
		const selector = msg.thread
		if (selector?.kind === 'new') {
			return { kind: 'ensure', handle: newThreadHandle(msg.id), title: selector.title }
		}
		if (selector?.kind === 'handle') {
			if (deps.threads.resolve(selector.handle) === undefined) {
				// The sender's transport could not check this before writing, and the message is
				// already delivered. The main timeline keeps the record whole; any other thread
				// would be a different conversation, which is the one thing a bad handle may
				// never become.
				log(
					`mirror: ${msg.id}: thread handle ${selector.handle} resolves to nothing; posting to the main timeline`
				)
				return { kind: 'timeline' }
			}
			return { kind: 'handle', handle: selector.handle }
		}
		if (msg.to.kind === 'epic' || recipients.length !== 1) return { kind: 'timeline' }

		const peer = recipients[0]
		const heard = deps.threads.lastThreadWith?.(sender.userId, peer.userId)
		if (heard !== undefined) return { kind: 'root', rootEventId: heard }
		return {
			kind: 'ensure',
			handle: pairThreadHandle(roomId, sender.userId, peer.userId),
			title: pairRootText(sender, peer)
		}
	}

	function pairRootText(a: MirrorIdentity, b: MirrorIdentity): string {
		return `${a.userId} ⇄ ${b.userId}`
	}

	function queueFor(roomId: string): RoomQueue {
		let queue = queues.get(roomId)
		if (queue === undefined) {
			queue = { jobs: [], busy: false }
			queues.set(roomId, queue)
		}
		return queue
	}

	function enqueue(job: Job): void {
		const queue = queueFor(job.roomId)
		queue.jobs.push(job)
		while (queue.jobs.length > maxQueue) {
			// The head may be mid-attempt or waiting on a retry timer; dropping it would leave
			// that attempt running against a job nobody holds. The oldest job that is not being
			// attempted goes instead, which is what unblocks the room without losing the work
			// already in flight.
			const victim = queue.jobs.splice(queue.busy ? 1 : 0, 1)[0]
			if (victim === undefined) break
			log(`mirror: queue for ${job.roomId} is full; dropped ${victim.messageId}`)
		}
		pump(job.roomId)
	}

	function backoffFor(attempts: number, retryAfterMs: number | undefined): number {
		const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS)
		return Math.max(capped * deps.random(), retryAfterMs ?? 0)
	}

	function retryLater(roomId: string, job: Job, retryAfterMs: number | undefined): void {
		const delay = backoffFor(job.attempts, retryAfterMs)
		job.attempts += 1
		const timer = setTimeout(() => {
			const queue = queueFor(roomId)
			queue.busy = false
			pump(roomId)
		}, delay)
		// A pending retry is not a reason to keep the process alive; nothing here is owed to
		// anyone once the broker is shutting down.
		timer.unref?.()
	}

	/** Finish with the head job, whatever the outcome, and move on to the next one. */
	function complete(roomId: string): void {
		const queue = queueFor(roomId)
		queue.jobs.shift()
		queue.busy = false
		pump(roomId)
	}

	/**
	 * Resolve the job's thread to a root event, posting a root first where one is needed. The
	 * root is remembered before the message is posted, so a message post that fails and retries
	 * adopts the root already created rather than opening a second one.
	 */
	async function rootFor(job: Job): Promise<{ ok: true; rootEventId?: string } | { ok: false }> {
		// `{ ok: false }` means only that a root could not be opened; an unresolvable handle is
		// not a failure here, it is a message that belongs on the main timeline.

		if (job.thread.kind === 'timeline') return { ok: true }
		if (job.thread.kind === 'root') return { ok: true, rootEventId: job.thread.rootEventId }
		const known = deps.threads.resolve(job.thread.handle)
		if (known !== undefined) return { ok: true, rootEventId: known }
		if (job.thread.kind === 'handle') {
			// It resolved when the job was planned and does not now. Same answer as a handle that
			// never resolved: the neutral timeline, never a thread we picked ourselves.
			log(
				`mirror: ${job.messageId}: thread ${job.thread.handle} no longer resolves; posting to the main timeline`
			)
			return { ok: true }
		}
		const opened = await deps.post({
			roomId: job.roomId,
			asUser: job.asUser,
			// Its own transaction id, derived from the message that opened it, so a retry of the
			// root is the same event rather than a second thread.
			txnId: `${job.messageId}:root`,
			text: job.thread.title,
			mentions: { userIds: [], room: false }
		})
		if (!opened.ok || opened.eventId === undefined) return { ok: false }
		deps.threads.remember(job.thread.handle, opened.eventId)
		return { ok: true, rootEventId: opened.eventId }
	}

	/** Attempt the head job of a room. Never rejects: every failure is turned into a retry. */
	async function attempt(roomId: string, job: Job): Promise<void> {
		let root: { ok: true; rootEventId?: string } | { ok: false }
		try {
			root = await rootFor(job)
		} catch (err) {
			log(`mirror: ${job.messageId} thread resolution failed: ${err}`)
			retryLater(roomId, job, undefined)
			return
		}
		if (!root.ok) {
			complete(roomId)
			return
		}

		let outcome: PostOutcome
		try {
			outcome = await deps.post({
				roomId: job.roomId,
				asUser: job.asUser,
				txnId: job.messageId,
				text: job.text,
				mentions: job.mentions,
				threadRootEventId: root.rootEventId
			})
		} catch (err) {
			log(`mirror: posting ${job.messageId} threw: ${err}`)
			retryLater(roomId, job, undefined)
			return
		}
		if (outcome.ok) {
			complete(roomId)
			return
		}
		log(`mirror: posting ${job.messageId} to ${roomId} failed; retrying`)
		retryLater(roomId, job, outcome.retryAfterMs)
	}

	function pump(roomId: string): void {
		const queue = queueFor(roomId)
		if (queue.busy) return
		const job = queue.jobs[0]
		if (job === undefined) return
		queue.busy = true
		// Caught here rather than by the caller: `onRouted` is called from `route()`, and a
		// rejection escaping this promise would reach the process's fatal handlers.
		attempt(roomId, job).catch((err: unknown) => {
			log(`mirror: ${job.messageId} failed unexpectedly: ${err}`)
			complete(roomId)
		})
	}

	function onRouted(msg: ChannelMessage): void {
		try {
			if (!remember(msg.id)) return
			const sender = deps.identify(msg.from.sessionId)
			if (sender === undefined) {
				log(`mirror: dropping ${msg.id}: its sender has no remote identity`)
				return
			}
			const room = planRoom(msg, sender)
			if (room === undefined) return
			const thread = planThread(msg, sender, room.roomId, room.recipients)
			if (thread === undefined) return
			enqueue({
				messageId: msg.id,
				roomId: room.roomId,
				asUser: sender.userId,
				text: msg.text,
				mentions: room.mentions,
				thread,
				attempts: 0
			})
		} catch (err) {
			// Called from inside `route()`: nothing here may reach the caller, whose job is
			// delivery and which has no stake in whether a mirror worked.
			log(`mirror: ${msg.id} could not be mirrored: ${err}`)
		}
	}

	return {
		onRouted,
		queuedFor: (roomId) => queues.get(roomId)?.jobs.length ?? 0
	}
}
