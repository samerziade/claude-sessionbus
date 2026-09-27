import type { HistoryMessage, HistoryQuery, HistoryResult } from '../../bus/src/mailbox.ts'
import type { MatrixClient } from './matrix-client.ts'
import { roomThreadHandle } from './matrix-mirror.ts'
import { localpartOf } from './matrix-names.ts'
import type { RelayIdentity } from './matrix-relay.ts'
import { type InboundEvent, inNamespace } from './matrix-relay-filter.ts'

/**
 * `read_history`, answered against the homeserver.
 *
 * Two rules shape it. **Any** room in the namespace is readable, so a session working one
 * grouping can look up how another solved something; writing stays limited to the rooms a
 * session belongs to, which is enforced elsewhere. And reading another group's room is a
 * lookup rather than consumption, so it records no cursor there — only a read of the caller's
 * own room advances one.
 *
 * Every request is made as the bot, like everything else the inbound half does. Nothing throws
 * across the boundary: a homeserver that cannot answer is `unavailable`, which is a complete
 * answer rather than an error to propagate into a session's turn.
 */

export interface HistoryDeps {
	client: Pick<MatrixClient, 'roomMessages' | 'resolveAlias'>
	botUser: string
	namespacePrefix: string
	/** Every identity currently registered. Read afresh on every call. */
	identities: () => RelayIdentity[]
	/** Whether a room id is one of the bridge's own rooms. */
	isBridgeRoom: (roomId: string) => boolean
	/**
	 * Record that an identity has consumed a room up to a position. Routed through the relay
	 * rather than written here, so cursor advance has exactly one home and a read cannot
	 * disagree with a wake about what has been seen.
	 */
	markRead: (identity: string, room: string, token: string) => void
	defaultLimit?: number
	maxLimit?: number
	log?: (msg: string) => void
}

export interface HistoryReader {
	read(identity: string, query: HistoryQuery): Promise<HistoryResult>
}

const DEFAULT_LIMIT = 50
const DEFAULT_MAX_LIMIT = 200

const NOT_FOUND: HistoryResult = { ok: false, reason: 'not_found' }
const UNAVAILABLE: HistoryResult = { ok: false, reason: 'unavailable' }

export function createHistoryReader(deps: HistoryDeps): HistoryReader {
	const log = deps.log ?? (() => {})
	const defaultLimit = deps.defaultLimit ?? DEFAULT_LIMIT
	const maxLimit = deps.maxLimit ?? DEFAULT_MAX_LIMIT

	/** The room a query names, as a room id, or nothing when it names none we may read. */
	async function resolveRoom(
		identity: RelayIdentity,
		room: string | undefined
	): Promise<string | undefined> {
		if (room === undefined) return identity.epicRoomId ?? identity.lobbyRoomId
		if (room.startsWith('#')) {
			// An alias carries its namespace in its own name, so the check is decidable before
			// anything is asked of the homeserver.
			if (!localpartOf(room).startsWith(`${deps.namespacePrefix}.`)) return undefined
			const resolved = await deps.client.resolveAlias(room, deps.botUser)
			return resolved.ok ? resolved.value.roomId : undefined
		}
		return deps.isBridgeRoom(room) ? room : undefined
	}

	function toHistoryMessage(event: InboundEvent): HistoryMessage | undefined {
		if (event.type !== 'm.room.message' || event.msgtype !== 'm.text') return undefined
		if (event.body === undefined) return undefined
		const entry: HistoryMessage = {
			from: localpartOf(event.sender),
			// The full Matrix id in both directions: it is what identifies an author inside the
			// room, and for a human it is what a reply's `to` accepts.
			from_id: event.sender,
			origin: inNamespace(event.sender, deps.namespacePrefix) ? 'session' : 'human',
			text: event.body,
			at: event.at
		}
		if (event.threadRootEventId !== undefined) {
			entry.thread = roomThreadHandle(event.roomId, event.threadRootEventId)
		}
		return entry
	}

	async function read(identityKey: string, query: HistoryQuery): Promise<HistoryResult> {
		try {
			const identity = deps.identities().find((i) => i.identity === identityKey)
			if (identity === undefined) return NOT_FOUND
			const roomId = await resolveRoom(identity, query.room)
			if (roomId === undefined) return NOT_FOUND

			const limit = Math.min(Math.max(1, query.limit ?? defaultLimit), maxLimit)
			// One more than asked for, so `more` is answered by what came back rather than by a
			// second request.
			const page = await deps.client.roomMessages(
				{
					roomId,
					from: query.since,
					// With a cursor, page forward from it; with none, the newest messages are what
					// a caller means by "the history", so page backwards from the present.
					dir: query.since === undefined ? 'b' : 'f',
					limit: limit + 1
				},
				deps.botUser
			)
			if (!page.ok) {
				log(`history: reading ${roomId} failed (${page.message})`)
				return UNAVAILABLE
			}

			const ordered =
				query.since === undefined ? [...page.value.events].reverse() : page.value.events
			let messages: HistoryMessage[] = []
			for (const event of ordered) {
				const entry = toHistoryMessage(event)
				if (entry !== undefined) messages.push(entry)
			}
			if (query.thread !== undefined) {
				messages = messages.filter((m) => m.thread === query.thread)
			}
			if (query.search !== undefined) {
				const needle = query.search.toLowerCase()
				messages = messages.filter((m) => m.text.toLowerCase().includes(needle))
			}
			const more = messages.length > limit
			// Paging backwards took the newest `limit + 1`; the extra one is the oldest of them.
			messages = query.since === undefined ? messages.slice(-limit) : messages.slice(0, limit)

			// Only a room the caller belongs to is *consumed* by reading it. Another grouping's
			// room is a lookup, and recording a cursor there would invent membership.
			const isMember = roomId === identity.epicRoomId || roomId === identity.lobbyRoomId
			const end = page.value.end
			if (isMember && end !== undefined && messages.length > 0) {
				deps.markRead(identityKey, roomId, end)
			}
			return { ok: true, room: roomId, messages, more }
		} catch (err) {
			log(`history: read failed: ${err}`)
			return UNAVAILABLE
		}
	}

	return { read }
}
