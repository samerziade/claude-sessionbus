import type { MatrixReplyRequest, MatrixReplyResult } from '../../bus/src/mailbox.ts'
import { type ChannelMessage, newMessageId, type RelayContext } from '../../bus/src/message.ts'
import type { BridgeState } from './bridge-state.ts'
import type { MatrixClient, SyncBatch } from './matrix-client.ts'
import { createInviteHandler, type InviteHandler } from './matrix-invites.ts'
import { roomThreadHandle } from './matrix-mirror.ts'
import { localpartOf } from './matrix-names.ts'
import { createInboundFilter, type InboundEvent, inNamespace } from './matrix-relay-filter.ts'
import { buildWindow, type WindowCaps, type WindowMessage } from './matrix-window.ts'

/**
 * The inbound half of the bridge: a human's mention in a room becomes a wake in a session.
 *
 * The shape is deliberately narrow — **one** new hop in front of the broker core's `route()`.
 * A mention becomes a `ChannelMessage` and is handed to the same call a local `send_message`
 * makes, so nothing downstream of `route()` knows Matrix exists and there is still exactly one
 * delivery path per message. Everything else here is about deciding *what* that one message
 * should contain.
 *
 * Four properties carry the weight:
 *
 * - **One stream, opened as the bot.** Every request is masqueraded as the configured bot user.
 *   The homeserver refuses to sync for an appservice's own sender identity and answers 500, so
 *   an unmasqueraded request is a defect rather than a style choice. A half-masqueraded relay —
 *   syncing as the bot, joining as the sender — would produce a room the stream cannot see,
 *   which reads as "the invite was accepted but nothing ever wakes".
 * - **The identity → session map is re-read at route time, never cached.** A session's id is
 *   not stable: a resumed launch rewrites it and the session re-registers. `route()` queues an
 *   unknown recipient with no log and no error, so a wake sent to a stale id reports success
 *   and is never delivered. That failure has shipped here once already.
 * - **Nothing throws across the boundary.** The process hosting this turns an unhandled
 *   rejection into a non-zero exit, so every async path carries its own handler and a
 *   homeserver outage costs wakes rather than the broker.
 * - **The position is persisted only after its batch is processed.** An interrupted batch is
 *   re-read, which is harmless — every event is deduplicated by id and the read cursor
 *   suppresses a replayed wake — whereas persisting first would skip events permanently.
 */

/** Where one work identity lives remotely. */
export interface RelayIdentity {
	/** The broker's work identity key — what `sessionForIdentity` is asked about. */
	identity: string
	/** The Matrix user it acts as. */
	userId: string
	/** Its session title, for naming it to the other identities an event called on. */
	name?: string
	epicRoomId?: string
	lobbyRoomId?: string
}

/** Where a human was last heard addressing an identity — the default target for a reply. */
export interface MentionTarget {
	roomId: string
	threadRootEventId?: string
	at: number
}

export interface RelayDeps {
	client: Pick<MatrixClient, 'sync' | 'joinRoom' | 'leaveRoom' | 'sendMessage'>
	state: BridgeState
	/** The broker core's own `route`. A caller, never a second delivery path. */
	route: (sessionId: string, msg: ChannelMessage) => void
	/** Every identity currently registered. Called afresh wherever it is needed. */
	identities: () => RelayIdentity[]
	/** The session id currently holding a work identity, or nothing. */
	sessionForIdentity: (identity: string) => string | undefined
	/** The user every request is made as. */
	botUser: string
	/** The only inviter whose invites are accepted. */
	operator?: string
	namespacePrefix: string
	caps: WindowCaps
	now: () => number
	/** Minutes to add to UTC when rendering a transcript's clock. */
	tzOffsetMinutes?: number
	syncTimeoutMs?: number
	/** How many recent messages are remembered per room, for building windows. */
	historyPerRoom?: number
	log?: (msg: string) => void
}

export interface MatrixRelay {
	/**
	 * Reconcile pending invites and settle the starting position. Run on every start, cold or
	 * warm: a pending invite is room *state*, reported once in an initial sync and never
	 * repeated by the incremental stream, so nothing else can recover one.
	 */
	start(): Promise<void>
	/** One sync iteration. Never rejects, and at most one is ever in flight. */
	step(): Promise<void>
	/** Loop `step` until `stop`. */
	run(): void
	stop(): void
	/** Wire into the broker's `onRegistered`: delivers any catch-up wake this identity is owed. */
	onRegistered(identity: string): void
	/**
	 * Record that an identity has read a room up to a position — what a history read of its own
	 * room means. Cursor advance has one home so a read and a wake cannot disagree about what
	 * has been seen.
	 */
	markRead(identity: string, room: string, token: string): void
	/** The room and thread a human last addressed an identity in, when one is remembered. */
	lastMention(identity: string, humanUserId: string): MentionTarget | undefined
	/** Post an identity's reply to a person, as that identity. Never rejects. */
	replyToHuman(identity: string, req: MatrixReplyRequest): Promise<MatrixReplyResult>
}

export interface ReplyTargetInput {
	/** Where that person last addressed this identity, if anywhere. */
	mention: MentionTarget | undefined
	identity: RelayIdentity
	/** Whether the identity is still in a room. Writing is limited to rooms it belongs to. */
	isMember: (roomId: string) => boolean
}

/**
 * Where a reply to a person goes: the room and thread of that person's most recent mention of
 * this identity. That default is what keeps a session called into a discussion answering *in*
 * the discussion rather than shouting into its own room. A remembered room the identity no
 * longer belongs to falls back to its own room, which enforces "write only where you are a
 * member" without a separate permission check.
 */
export function resolveReplyTarget(
	input: ReplyTargetInput
): { roomId: string; threadRootEventId?: string } | undefined {
	const mention = input.mention
	if (mention !== undefined && input.isMember(mention.roomId)) {
		return mention.threadRootEventId === undefined
			? { roomId: mention.roomId }
			: { roomId: mention.roomId, threadRootEventId: mention.threadRootEventId }
	}
	const own = input.identity.epicRoomId ?? input.identity.lobbyRoomId
	return own === undefined ? undefined : { roomId: own }
}

const DEFAULT_SYNC_TIMEOUT_MS = 30_000
const DEFAULT_HISTORY_PER_ROOM = 500
/** How long the loop waits after a failed iteration before asking again. */
const FAILURE_BACKOFF_MS = 5_000
/** A thread's title is the first line of its root, kept short enough to read in meta. */
const THREAD_TITLE_MAX = 80

/** One remembered message, with the position it occupies in the relay's own ordering. */
interface RingEntry {
	seq: number
	event: InboundEvent
}

function cursorKey(identity: string, room: string): string {
	return `${identity}\u0000${room}`
}

export function createMatrixRelay(deps: RelayDeps): MatrixRelay {
	const log = deps.log ?? (() => {})
	const syncTimeoutMs = deps.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS
	const historyPerRoom = deps.historyPerRoom ?? DEFAULT_HISTORY_PER_ROOM

	/** Recent messages per room, oldest first. The window builder reads from here. */
	const ring = new Map<string, RingEntry[]>()
	/** Ids already in the ring: a namespace sender bypasses the filter's dedupe by design. */
	const ringIds = new Set<string>()
	let seq = 0
	/** Where a stream token sits in the relay's own ordering, for slicing the ring. */
	const tokenPos = new Map<string, number>()
	/**
	 * How far each identity has been delivered in each room, precise to the event. The persisted
	 * cursor is a batch-grained token, which is all a history read needs; this is what keeps a
	 * second mention inside the same batch from reporting the first one again.
	 */
	const delivered = new Map<string, number>()
	const displayNames = new Map<string, string>()
	const mentionMemory = new Map<string, Map<string, MentionTarget>>()

	const invites: InviteHandler = createInviteHandler({
		client: deps.client,
		botUser: deps.botUser,
		operator: deps.operator,
		log
	})

	const filter = createInboundFilter({
		namespacePrefix: deps.namespacePrefix,
		isRegistered: (userId) => deps.identities().some((i) => i.userId === userId),
		registeredMembers: (roomId) => membersOf(roomId).map((i) => i.userId)
	})

	let position: string | undefined
	/** The position the relay started from — where the ring begins for an identity with no cursor. */
	let startToken: string | undefined
	let inFlight = false
	let stopped = false
	let timer: ReturnType<typeof setTimeout> | undefined

	function membersOf(roomId: string): RelayIdentity[] {
		return deps.identities().filter((i) => i.epicRoomId === roomId || i.lobbyRoomId === roomId)
	}

	function identityFor(userId: string): RelayIdentity | undefined {
		return deps.identities().find((i) => i.userId === userId)
	}

	function nameOf(userId: string): string {
		return displayNames.get(userId) ?? localpartOf(userId)
	}

	function remember(event: InboundEvent): void {
		if (ringIds.has(event.eventId)) return
		ringIds.add(event.eventId)
		seq += 1
		const entries = ring.get(event.roomId) ?? []
		entries.push({ seq, event })
		while (entries.length > historyPerRoom) {
			const evicted = entries.shift()
			if (evicted !== undefined) ringIds.delete(evicted.event.eventId)
		}
		ring.set(event.roomId, entries)
	}

	/** The handle naming an event's thread, recorded so a session can address it by that handle. */
	function threadHandleOf(event: InboundEvent): string | undefined {
		const root = event.threadRootEventId
		if (root === undefined) return undefined
		const handle = roomThreadHandle(event.roomId, root)
		if (deps.state.resolveThread(handle) === undefined) deps.state.rememberThread(handle, root)
		return handle
	}

	function threadTitleOf(event: InboundEvent): string | undefined {
		const root = event.threadRootEventId
		if (root === undefined) return undefined
		const entry = ring.get(event.roomId)?.find((e) => e.event.eventId === root)
		const body = entry?.event.body
		if (body === undefined) return undefined
		return body.split('\n')[0].slice(0, THREAD_TITLE_MAX)
	}

	function toWindowMessage(entry: RingEntry): WindowMessage {
		const event = entry.event
		return {
			eventId: event.eventId,
			sender: event.sender,
			senderDisplayName: displayNames.get(event.sender),
			body: event.body ?? '',
			at: event.at,
			threadHandle: threadHandleOf(event)
		}
	}

	/** Where an identity's unread window starts in a room. */
	function windowStart(identity: string, room: string): number {
		const known = delivered.get(cursorKey(identity, room))
		if (known !== undefined) return known
		const cursor = deps.state.getCursor(identity, room)
		if (cursor === undefined) return 0
		// A token from a previous run names a position this run's ordering does not hold. The
		// ring only covers what this run has seen, so its whole contents are the unread window.
		return tokenPos.get(cursor.token) ?? 0
	}

	/** The cursor an identity would report as `since`: what it held *before* this delivery. */
	function sinceFor(identity: string, room: string): string {
		return deps.state.getCursor(identity, room)?.token ?? startToken ?? ''
	}

	function advance(identity: string, room: string, upToSeq: number, token: string): void {
		delivered.set(cursorKey(identity, room), upToSeq)
		deps.state.setCursor(identity, room, { token, at: deps.now() })
	}

	function rememberMention(identity: string, event: InboundEvent): void {
		const byHuman = mentionMemory.get(identity) ?? new Map<string, MentionTarget>()
		byHuman.set(event.sender, {
			roomId: event.roomId,
			threadRootEventId: event.threadRootEventId,
			at: event.at
		})
		mentionMemory.set(identity, byHuman)
	}

	/**
	 * Build and route one identity's wake for one waking event. Returns whether it was
	 * delivered: an identity with no live session is owed the messages still, so nothing is
	 * consumed on its behalf and the mention becomes its catch-up on the next register.
	 */
	function wake(args: {
		identity: RelayIdentity
		room: string
		upToSeq: number
		wakingEvent: InboundEvent
		others: string[]
		token: string
	}): boolean {
		const sessionId = deps.sessionForIdentity(args.identity.identity)
		if (sessionId === undefined) return false

		const start = windowStart(args.identity.identity, args.room)
		const entries = (ring.get(args.room) ?? []).filter(
			(e) => e.seq > start && e.seq <= args.upToSeq
		)
		if (entries.length === 0) return false
		const since = sinceFor(args.identity.identity, args.room)
		const window = buildWindow({
			messages: entries.map(toWindowMessage),
			wakeThread: threadHandleOf(args.wakingEvent),
			caps: deps.caps,
			tzOffsetMinutes: deps.tzOffsetMinutes
		})

		const relay: RelayContext = {
			room: args.room,
			unread: window.unread,
			omitted: window.omitted,
			since
		}
		const thread = threadHandleOf(args.wakingEvent)
		if (thread !== undefined) {
			relay.thread = thread
			const title = threadTitleOf(args.wakingEvent)
			if (title !== undefined) relay.threadTitle = title
		}
		if (args.others.length > 0) relay.mentions = args.others

		const msg: ChannelMessage = {
			id: newMessageId(deps.now()),
			from: {
				sessionId: args.wakingEvent.sender,
				userId: args.wakingEvent.sender,
				name: nameOf(args.wakingEvent.sender),
				role: 'none',
				origin: 'human'
			},
			to: { kind: 'session', value: sessionId },
			text: window.content,
			createdAt: args.wakingEvent.at,
			relay
		}
		deps.route(sessionId, msg)
		advance(args.identity.identity, args.room, args.upToSeq, args.token)
		return true
	}

	function fanOut(event: InboundEvent, targets: string[], token: string, upToSeq: number): void {
		for (const userId of targets) {
			// Re-read per target: an identity may have re-registered since the batch arrived, and
			// a wake routed to the id it replaced is queued under an id nobody holds.
			const identity = identityFor(userId)
			if (identity === undefined) continue
			rememberMention(identity.identity, event)
			const others = targets.filter((u) => u !== userId).map((u) => identityFor(u)?.name ?? u)
			wake({ identity, room: event.roomId, upToSeq, wakingEvent: event, others, token })
		}
	}

	async function processBatch(batch: SyncBatch): Promise<void> {
		// Invites first: a room the bot joins here is one this same batch may already carry
		// messages for, and there is no second stream to pick them up.
		await invites.onBatch(batch)
		for (const [userId, name] of Object.entries(batch.displayNames)) displayNames.set(userId, name)
		for (const [_roomId, prev] of Object.entries(batch.prevBatch)) {
			if (!tokenPos.has(prev)) tokenPos.set(prev, seq)
		}

		const wakes: { event: InboundEvent; targets: string[]; seq: number }[] = []
		for (const event of batch.events) {
			// A room whose invite we declined is a room we are not in; anything the homeserver
			// still reports for it is not ours to act on.
			if (invites.isDeclined(event.roomId)) continue
			const decision = filter(event)
			if (decision.kind === 'ignore') continue
			remember(event)
			if (decision.kind === 'wake') {
				wakes.push({ event, targets: decision.targets, seq })
			}
		}
		tokenPos.set(batch.nextBatch, seq)
		for (const w of wakes) fanOut(w.event, w.targets, batch.nextBatch, w.seq)

		position = batch.nextBatch
		deps.state.setSyncToken(batch.nextBatch, deps.botUser)
	}

	/**
	 * The start-up reconciliation sync: no `since`, an empty timeline by filter. It is the
	 * protocol's full snapshot of the account, which is the only place a pending invite appears
	 * — an incremental stream reports a membership change once, in the batch where it happened,
	 * and the position is persisted past it.
	 */
	async function reconcile(): Promise<void> {
		const resume = deps.state.getSyncToken(deps.botUser)
		const result = await deps.client.sync({ emptyTimeline: true }, deps.botUser)
		if (!result.ok) {
			log(`relay: reconciliation sync failed (${result.message})`)
			return
		}
		await invites.onBatch(result.value)
		// On a warm start the snapshot's own position is discarded: the stream resumes from what
		// was persisted, or every timeline event since would be lost. On a cold start it *is*
		// the position, and nothing that predates it is ever relayed.
		position = resume ?? result.value.nextBatch
		startToken = position
		tokenPos.set(position, seq)
		if (resume === undefined) deps.state.setSyncToken(position, deps.botUser)
	}

	async function step(): Promise<void> {
		if (inFlight || stopped) return
		inFlight = true
		try {
			if (position === undefined) {
				// No usable position yet — a first run, or a reconciliation that could not be
				// completed. Retry it rather than opening a stream with no `since`, which would
				// hand us the whole of every room's history as though it were new.
				await reconcile()
				return
			}
			const result = await deps.client.sync(
				{ since: position, timeoutMs: syncTimeoutMs },
				deps.botUser
			)
			if (!result.ok) {
				log(`relay: sync failed (${result.message})`)
				return
			}
			await processBatch(result.value)
		} catch (err) {
			// The loop is the last place a rejection can be caught before the process-level
			// backstop turns it into a non-zero exit.
			log(`relay: sync iteration failed: ${err}`)
		} finally {
			inFlight = false
		}
	}

	function run(): void {
		if (stopped) return
		const before = position
		step()
			.then(() => {
				if (stopped) return
				// Back off only when the iteration made no progress; a healthy long-poll already
				// paces the loop by itself.
				const delay = position === before && position !== undefined ? FAILURE_BACKOFF_MS : 0
				timer = setTimeout(run, delay)
				timer.unref?.()
			})
			.catch((err: unknown) => log(`relay: loop failed: ${err}`))
	}

	function stop(): void {
		stopped = true
		if (timer !== undefined) clearTimeout(timer)
		timer = undefined
	}

	/**
	 * Whether an event would wake this identity — the same rules the filter chain applies, asked
	 * of the ring rather than of a live batch. Sharing the rules is what keeps a catch-up wake
	 * from differing from the live one it stands in for.
	 */
	function wakesIdentity(event: InboundEvent, identity: RelayIdentity): boolean {
		if (inNamespace(event.sender, deps.namespacePrefix)) return false
		if (event.type !== 'm.room.message' || event.msgtype !== 'm.text') return false
		if (event.sender === identity.userId) return false
		if (event.mentionedUserIds.includes(identity.userId)) return true
		return (
			event.mentionsRoom &&
			(identity.epicRoomId === event.roomId || identity.lobbyRoomId === event.roomId)
		)
	}

	function onRegistered(identityKey: string): void {
		try {
			const identity = deps.identities().find((i) => i.identity === identityKey)
			if (identity === undefined) return
			if (deps.sessionForIdentity(identityKey) === undefined) return
			const token = position
			if (token === undefined) return
			for (const [room, entries] of ring) {
				const start = windowStart(identityKey, room)
				const unread = entries.filter((e) => e.seq > start)
				// A mention is what wakes; unread chatter is history the session may read when it
				// chooses. The window still runs up to the *last* mention, so one wake carries
				// everything missed rather than one wake per missed mention.
				const lastMentionSeq = unread.filter((e) => wakesIdentity(e.event, identity)).at(-1)?.seq
				if (lastMentionSeq === undefined) continue
				const wakingEntry = unread.find((e) => e.seq === lastMentionSeq)
				if (wakingEntry === undefined) continue
				wake({
					identity,
					room,
					upToSeq: lastMentionSeq,
					wakingEvent: wakingEntry.event,
					others: [],
					token
				})
			}
		} catch (err) {
			// Called from inside the broker's register path: nothing here may reach the caller,
			// whose job is binding a session and which has no stake in a catch-up.
			log(`relay: catch-up for ${identityKey} failed: ${err}`)
		}
	}

	async function start(): Promise<void> {
		try {
			await reconcile()
		} catch (err) {
			log(`relay: start failed: ${err}`)
		}
	}

	/**
	 * A token minted by a history page, not by this run's stream, so its position in the ring is
	 * unknown: everything currently remembered for the room counts as read. That is the safe
	 * direction — the alternative would re-deliver as "unread" messages the session has just been
	 * handed.
	 */
	function markRead(identity: string, room: string, token: string): void {
		const here = ring.get(room)?.at(-1)?.seq ?? seq
		advance(identity, room, Math.max(here, windowStart(identity, room)), token)
	}

	async function replyToHuman(
		identityKey: string,
		req: MatrixReplyRequest
	): Promise<MatrixReplyResult> {
		try {
			const identity = deps.identities().find((i) => i.identity === identityKey)
			if (identity === undefined) return { ok: false, reason: 'not_found' }
			const target = resolveReplyTarget({
				mention: mentionMemory.get(identityKey)?.get(req.to),
				identity,
				isMember: (roomId) => roomId === identity.epicRoomId || roomId === identity.lobbyRoomId
			})
			if (target === undefined) return { ok: false, reason: 'not_found' }
			// Posted as the session's own user, never as the bot: the record should say who
			// answered, and the bot takes part in no conversation.
			const posted = await deps.client.sendMessage(
				{
					roomId: target.roomId,
					text: req.text,
					txnId: newMessageId(deps.now()),
					threadRootEventId: target.threadRootEventId,
					mentions: { userIds: [req.to], room: false }
				},
				identity.userId
			)
			if (!posted.ok) {
				log(`relay: replying to ${req.to} failed (${posted.message})`)
				return { ok: false, reason: 'unavailable' }
			}
			const thread =
				target.threadRootEventId === undefined
					? undefined
					: roomThreadHandle(target.roomId, target.threadRootEventId)
			return thread === undefined
				? { ok: true, room: target.roomId }
				: { ok: true, room: target.roomId, thread }
		} catch (err) {
			log(`relay: replying to ${req.to} threw: ${err}`)
			return { ok: false, reason: 'unavailable' }
		}
	}

	return {
		start,
		step,
		run,
		stop,
		onRegistered,
		markRead,
		replyToHuman,
		lastMention: (identity, humanUserId) => mentionMemory.get(identity)?.get(humanUserId)
	}
}
