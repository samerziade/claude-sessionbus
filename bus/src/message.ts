import { randomBytes } from 'node:crypto'

/**
 * Where a message came from. A human mention relayed in from Matrix usually outranks a peer
 * session's, and the sender's name alone cannot tell the two apart.
 */
export type MessageOrigin = 'session' | 'human'

export interface MessageFrom {
	sessionId: string
	name: string
	epic?: string
	role: 'pm' | 'worker' | 'none'
	/** Absent means `session`, which is what every locally routed message is. */
	origin?: MessageOrigin
	/**
	 * The sender's full Matrix user id, set only for a `human` sender. `from_id` has to stay a
	 * value a reply's `to` accepts, and for a human that is the Matrix id — a short session id
	 * would name a session that does not exist.
	 */
	userId?: string
}

/**
 * What a relayed wake carries beyond an ordinary message: which room it happened in, how much
 * of the backlog came with it, and the cursor to hand a history read. Declared here, at the
 * message's own home, so the relay that fills it and the mapping that renders it cannot drift.
 */
export interface RelayContext {
	/** Where to read more, and where a reply lands. */
	room: string
	/** How many messages the window delivered. */
	unread: number
	/** How many the cap dropped; `unread + omitted` is the whole backlog. */
	omitted: number
	/** The read cursor as it stood *before* this wake, so a history read replays the window. */
	since: string
	thread?: string
	threadTitle?: string
	/** The *other* identities the same event named, so several sessions do not all answer. */
	mentions?: string[]
}

export interface MessageTo {
	kind: 'session' | 'epic'
	value: string
	/**
	 * Every session a multi-recipient call resolved to, in resolution order. Absent when the
	 * call named one recipient, whom `value` already names. Carried because a fan-out is one
	 * logical message: whatever mirrors it sees each copy separately and could not otherwise
	 * tell who else was addressed.
	 */
	recipients?: string[]
}

/**
 * Which remote thread a mirrored copy of this message belongs in. A handle names a thread that
 * already exists; `new` asks for one to be started under `title`.
 */
export type ThreadSelector = { kind: 'handle'; handle: string } | { kind: 'new'; title: string }

/**
 * A thread handle: the `t_` marker and at least one character naming the thread, with nothing
 * that would not survive being read back out of a transcript. Shape is decidable here, with no
 * lookup, which is what lets a typo be refused wherever `send_message` runs — the lookup itself
 * is not reachable from every transport.
 */
const THREAD_HANDLE_RE = /^t_[A-Za-z0-9_-]+$/

export function isThreadHandle(value: string): boolean {
	return THREAD_HANDLE_RE.test(value)
}

export interface ChannelMessage {
	id: string
	from: MessageFrom
	to: MessageTo
	text: string
	createdAt: number
	/**
	 * Inert for local delivery: it is carried for the outbound mirror and deliberately absent
	 * from `toChannelMeta`, so a thread choice can never change what a recipient session sees.
	 */
	thread?: ThreadSelector
	/**
	 * Present only on a wake relayed in from Matrix. Unlike `thread`, this *is* mapped into
	 * channel meta: it is the context the woken session needs to answer.
	 */
	relay?: RelayContext
}

/** Sortable, dependency-free id: base36(timestamp) + '-' + random hex. */
export function newMessageId(now: number, rand: string = randomBytes(4).toString('hex')): string {
	return `${now.toString(36)}-${rand}`
}

/** First six hex chars of a session UUID, hyphens removed — used as from_id. */
export function shortId(sessionId: string): string {
	return sessionId.replace(/-/g, '').slice(0, 6)
}

/**
 * Build the <channel> tag attributes. Keys must be identifier-safe
 * (letters/digits/underscore); the channel contract silently drops others.
 */
export function toChannelMeta(msg: ChannelMessage): Record<string, string> {
	const origin = msg.from.origin ?? 'session'
	const meta: Record<string, string> = {
		from: msg.from.name,
		from_id:
			origin === 'human' ? (msg.from.userId ?? msg.from.sessionId) : shortId(msg.from.sessionId),
		origin,
		role: msg.from.role,
		msg_id: msg.id
	}
	if (msg.from.epic) meta.epic = msg.from.epic
	const relay = msg.relay
	if (relay !== undefined) {
		meta.room = relay.room
		// Counts are rendered as decimal strings: every meta value is a string, and a number
		// would be dropped by the channel contract rather than coerced.
		meta.unread = String(relay.unread)
		meta.omitted = String(relay.omitted)
		meta.since = relay.since
		if (relay.thread !== undefined) meta.thread = relay.thread
		if (relay.threadTitle !== undefined) meta.thread_title = relay.threadTitle
		if (relay.mentions !== undefined && relay.mentions.length > 0) {
			meta.mentions = relay.mentions.join(',')
		}
	}
	return meta
}
