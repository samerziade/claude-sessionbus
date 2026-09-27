import { localpartOf } from './matrix-names.ts'

/**
 * The chain every inbound room event passes before anything is woken. Pure decision logic over
 * an already-parsed event plus the *current* registered set, so the whole of "what wakes a
 * session" is one small, exhaustively testable function rather than a condition spread through
 * the sync loop.
 *
 * The order is normative and the first rule carries the most weight: an event sent by a user
 * inside the namespace is never a wake, whatever it says. Session traffic reaches Matrix only
 * as a mirror, so dropping namespace senders leaves exactly one delivery path per message and
 * makes an echo loop unconstructible rather than merely unlikely.
 *
 * Nothing here is cached. `isRegistered` and `registeredMembers` are called afresh on every
 * event, because the identity → session map is rebound on every register and a snapshot taken
 * when the loop started would wake an id nobody holds.
 */

/** A parsed room event, as the sync stream hands it over. */
export interface InboundEvent {
	eventId: string
	roomId: string
	/** Full Matrix user id of the sender. */
	sender: string
	/** The event type, e.g. `m.room.message`. */
	type: string
	/** The message type, e.g. `m.text`. Absent for a non-message event. */
	msgtype?: string
	body?: string
	/** The sender's display name in this room, when the stream has told us one. */
	senderDisplayName?: string
	/** Origin-server timestamp. */
	at: number
	/** The thread root this event hangs off, when it is in a thread. */
	threadRootEventId?: string
	/** `m.mentions.user_ids` — the only thing that wakes anything. */
	mentionedUserIds: string[]
	/** `m.mentions.room` — a call on everyone in the room. */
	mentionsRoom: boolean
}

/**
 * What the chain decided.
 *
 * - `wake` — record it and wake each named identity.
 * - `history` — record it; it wakes nothing. Namespace traffic and unaddressed chatter both
 *   land here, because a session reading its room should see the whole conversation.
 * - `ignore` — not ours: already processed, or not a plain text message.
 */
export type FilterDecision =
	| { kind: 'wake'; targets: string[] }
	| { kind: 'history' }
	| { kind: 'ignore' }

export interface InboundFilterDeps {
	/** Namespace prefix claimed by the appservice registration, e.g. `cc`. */
	namespacePrefix: string
	/** How many recently processed event ids are remembered. */
	dedupeMax?: number
	/** Whether a Matrix user id names an identity currently registered with the broker. */
	isRegistered: (userId: string) => boolean
	/** The registered identities currently in a room — what a room-wide mention resolves to. */
	registeredMembers: (roomId: string) => string[]
}

const DEFAULT_DEDUPE_MAX = 2_000

const HISTORY: FilterDecision = { kind: 'history' }
const IGNORE: FilterDecision = { kind: 'ignore' }

/**
 * Whether a user id sits inside the appservice namespace. Compared on the localpart's first
 * segment, not as a bare string prefix: `@ccx.…` is not inside `cc.`, and treating it as if it
 * were would silence a real person whose name happens to start with the prefix.
 */
export function inNamespace(userId: string, prefix: string): boolean {
	return localpartOf(userId).startsWith(`${prefix}.`)
}

export function createInboundFilter(
	deps: InboundFilterDeps
): (event: InboundEvent) => FilterDecision {
	const dedupeMax = deps.dedupeMax ?? DEFAULT_DEDUPE_MAX
	// Bounded, oldest evicted first: this runs for weeks, and the cost of an eviction is one
	// replayed event, which the read cursor suppresses anyway.
	const seen = new Set<string>()
	const order: string[] = []

	function remember(eventId: string): boolean {
		if (seen.has(eventId)) return false
		seen.add(eventId)
		order.push(eventId)
		while (order.length > dedupeMax) {
			const evicted = order.shift()
			if (evicted !== undefined) seen.delete(evicted)
		}
		return true
	}

	return function decide(event: InboundEvent): FilterDecision {
		// 1. A namespace sender is history and nothing else — deliberately ahead of dedupe, so
		//    its id is left unclaimed rather than shadowing a later event that shares it.
		if (inNamespace(event.sender, deps.namespacePrefix)) return HISTORY
		// 2. Seen already.
		if (!remember(event.eventId)) return IGNORE
		// 3. Plain text room messages only: no edits, reactions, media or state.
		if (event.type !== 'm.room.message') return IGNORE
		if (event.msgtype !== 'm.text' || event.body === undefined) return IGNORE

		// 4. Only an explicit mention wakes anything; everything else is history.
		const named = event.mentionsRoom
			? [...event.mentionedUserIds, ...deps.registeredMembers(event.roomId)]
			: event.mentionedUserIds
		const targets: string[] = []
		for (const userId of named) {
			// 5. Never wake the identity that sent it.
			if (userId === event.sender) continue
			if (targets.includes(userId)) continue
			if (!deps.isRegistered(userId)) continue
			targets.push(userId)
		}
		if (targets.length > 0) return { kind: 'wake', targets }
		// Nobody left to wake. An event that named only its own sender was aimed at nobody
		// else and is discarded outright; anything else is part of the room's record.
		const namedSelfOnly = named.length > 0 && named.every((userId) => userId === event.sender)
		return namedSelfOnly ? IGNORE : HISTORY
	}
}
