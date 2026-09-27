import type { MirrorMentions } from './matrix-mirror.ts'
import { localpartOf } from './matrix-names.ts'
import type { InboundEvent } from './matrix-relay-filter.ts'

/**
 * The one place that talks to the homeserver. `fetch` is injected, so every layer above this
 * one is testable without a network — and every call returns a typed result rather than
 * throwing, because the process hosting this treats an unhandled rejection as fatal and a
 * homeserver outage is not a reason to end the broker.
 *
 * Every call names the user it acts for (`?user_id=`), the bridge's own user included: the
 * credential's sender identity is a separate idle account that takes part in nothing, so an
 * unattributed call is a call made by the wrong user — a room the bridge is not in and cannot
 * hear. `asUser` is therefore required rather than optional, which turns a forgotten argument
 * into a type error. Registration is the one exception: an account cannot be acted as before
 * it exists.
 */

/** The token never appears in a message, so a failure is safe to log and to serialize. */
export type MatrixErrorKind = 'auth' | 'rate_limited' | 'server' | 'network' | 'matrix'

export interface MatrixOk<T> {
	ok: true
	value: T
}

export interface MatrixErr {
	ok: false
	kind: MatrixErrorKind
	status?: number
	errcode?: string
	retryAfterMs?: number
	message: string
}

export type MatrixResult<T> = MatrixOk<T> | MatrixErr

/** The slice of the runtime's `fetch` this client uses; the global `fetch` satisfies it. */
export interface HttpRequest {
	method: string
	headers: Record<string, string>
	body?: string
}

export interface HttpResponse {
	status: number
	text(): Promise<string>
}

export type FetchLike = (url: string, init: HttpRequest) => Promise<HttpResponse>

export interface RoomRef {
	roomId: string
}

export interface JoinedRooms {
	rooms: string[]
}

export interface CreateRoomRequest {
	/** Fully qualified alias; only its localpart goes on the wire. */
	alias: string
	name?: string
	topic?: string
	invite?: string[]
}

export interface SyncOptions {
	/** Where to resume from. Absent asks the homeserver for a full snapshot and "now". */
	since?: string
	/** How long the homeserver may hold the request open. */
	timeoutMs?: number
	/**
	 * Ask for no timeline events at all. The start-up reconciliation sync uses this: it wants
	 * the account's *state* — above all its pending invites — without relaying anything that
	 * predates the start.
	 */
	emptyTimeline?: boolean
}

/** A pending invite addressed to the syncing user. */
export interface SyncInvite {
	roomId: string
	/**
	 * Sender of the syncing user's own invite membership event. Absent when the stripped state
	 * did not carry one, which is not the same as "invited by nobody" — see `decideInvite`.
	 */
	inviter?: string
}

export interface SyncBatch {
	/** The position to resume from, once this batch has been processed. */
	nextBatch: string
	events: InboundEvent[]
	/** Per-room `prev_batch`: the position immediately before this batch's first event. */
	prevBatch: Record<string, string>
	invites: SyncInvite[]
	joinedRooms: string[]
	/** Rooms the user has left — including one whose pending invite was withdrawn. */
	leftRooms: string[]
	/** Display names seen on member events in this batch, keyed by user id. */
	displayNames: Record<string, string>
}

export interface RoomMessagesRequest {
	roomId: string
	/** A stream token from a sync or a previous page. Absent starts at the end the `dir` implies. */
	from?: string
	/** `f` pages forward from `from`; `b` pages backwards, which is how "recent" is read. */
	dir?: 'f' | 'b'
	limit?: number
}

export interface RoomMessagesPage {
	events: InboundEvent[]
	/** The token to page on from. */
	end?: string
}

export interface SendMessageRequest {
	roomId: string
	text: string
	/** So a retried post is the same event rather than a second one. */
	txnId: string
	threadRootEventId?: string
	mentions?: MirrorMentions
}

export interface SentEvent {
	eventId?: string
}

export interface MatrixClient {
	registerUser(userId: string): Promise<MatrixResult<void>>
	setDisplayName(userId: string, displayName: string, asUser: string): Promise<MatrixResult<void>>
	createRoom(req: CreateRoomRequest, asUser: string): Promise<MatrixResult<RoomRef>>
	createSpace(req: CreateRoomRequest, asUser: string): Promise<MatrixResult<RoomRef>>
	resolveAlias(alias: string, asUser: string): Promise<MatrixResult<RoomRef>>
	joinRoom(roomIdOrAlias: string, asUser: string): Promise<MatrixResult<RoomRef>>
	invite(roomId: string, userId: string, asUser: string): Promise<MatrixResult<void>>
	linkSpaceChild(spaceId: string, childRoomId: string, asUser: string): Promise<MatrixResult<void>>
	listJoinedRooms(asUser: string): Promise<MatrixResult<JoinedRooms>>
	/**
	 * One long-poll over every room the user is in. Opened *as the bot*, never as the
	 * credential's sender identity: the homeserver refuses to sync for an appservice's own
	 * sender and answers 500, so the masquerade here is a correctness requirement.
	 */
	sync(opts: SyncOptions, asUser: string): Promise<MatrixResult<SyncBatch>>
	/** Leave a room — which is also how the protocol declines a pending invite. */
	leaveRoom(roomId: string, asUser: string): Promise<MatrixResult<void>>
	/** Page forward through a room's timeline from a stream token. */
	roomMessages(req: RoomMessagesRequest, asUser: string): Promise<MatrixResult<RoomMessagesPage>>
	sendMessage(req: SendMessageRequest, asUser: string): Promise<MatrixResult<SentEvent>>
}

export interface MatrixClientOptions {
	fetch: FetchLike
	baseUrl: string
	/** Read only when a request is built; never copied into a result or a log line. */
	token: string
	log?: (msg: string) => void
}

const API = '/_matrix/client/v3'

interface RequestSpec {
	method: string
	path: string
	/** A compile-time label for logs — never built from the request or its headers. */
	op: string
	asUser?: string
	body?: Record<string, unknown>
	query?: Record<string, string>
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** The domain half of a fully qualified identifier: `!room:host` → `host`. */
function domainOf(id: string): string {
	const colonAt = id.indexOf(':')
	return colonAt === -1 ? '' : id.slice(colonAt + 1)
}

function asString(x: unknown): string | undefined {
	return typeof x === 'string' ? x : undefined
}

function asRecord(x: unknown): Record<string, unknown> {
	return isPlainObject(x) ? x : {}
}

function asArray(x: unknown): unknown[] {
	return Array.isArray(x) ? x : []
}

function stringList(x: unknown): string[] {
	return asArray(x).filter((v): v is string => typeof v === 'string')
}

/**
 * One timeline event, parsed. Returns nothing only when the event has no id or sender — every
 * other shape is carried through, because deciding what is relayable belongs to the filter
 * chain and not to the wire parser.
 */
function parseEvent(roomId: string, raw: unknown): InboundEvent | undefined {
	if (!isPlainObject(raw)) return undefined
	const eventId = asString(raw.event_id)
	const sender = asString(raw.sender)
	const type = asString(raw.type)
	if (eventId === undefined || sender === undefined || type === undefined) return undefined
	const content = asRecord(raw.content)
	const mentions = asRecord(content['m.mentions'])
	const relates = asRecord(content['m.relates_to'])
	const isThread = relates.rel_type === 'm.thread'
	const at = raw.origin_server_ts
	return {
		eventId,
		roomId,
		sender,
		type,
		msgtype: asString(content.msgtype),
		body: asString(content.body),
		at: typeof at === 'number' ? at : 0,
		threadRootEventId: isThread ? asString(relates.event_id) : undefined,
		mentionedUserIds: stringList(mentions.user_ids),
		mentionsRoom: mentions.room === true
	}
}

/** The display name a member event announces, when it announces one. */
function collectDisplayName(raw: unknown, into: Record<string, string>): void {
	if (!isPlainObject(raw)) return
	if (raw.type !== 'm.room.member') return
	const userId = asString(raw.state_key)
	const displayname = asString(asRecord(raw.content).displayname)
	if (userId !== undefined && displayname !== undefined) into[userId] = displayname
}

/**
 * Who invited `botUser` into this room, from the stripped `invite_state`. Read from the
 * sender of the bot's *own* membership event and nothing else: a display name is free text,
 * and another user's membership event says nothing about who did the inviting.
 */
function parseInviter(raw: unknown, botUser: string): string | undefined {
	for (const event of asArray(asRecord(asRecord(raw).invite_state).events)) {
		if (!isPlainObject(event)) continue
		if (event.type !== 'm.room.member' || event.state_key !== botUser) continue
		return asString(event.sender)
	}
	return undefined
}

function parseSyncBatch(body: Record<string, unknown>, botUser: string): SyncBatch | undefined {
	const nextBatch = asString(body.next_batch)
	if (nextBatch === undefined) return undefined
	const rooms = asRecord(body.rooms)
	const events: InboundEvent[] = []
	const prevBatch: Record<string, string> = {}
	const displayNames: Record<string, string> = {}
	const joinedRooms: string[] = []

	for (const [roomId, room] of Object.entries(asRecord(rooms.join))) {
		joinedRooms.push(roomId)
		const joined = asRecord(room)
		const timeline = asRecord(joined.timeline)
		const prev = asString(timeline.prev_batch)
		if (prev !== undefined) prevBatch[roomId] = prev
		for (const raw of asArray(asRecord(joined.state).events)) collectDisplayName(raw, displayNames)
		for (const raw of asArray(timeline.events)) {
			collectDisplayName(raw, displayNames)
			const parsed = parseEvent(roomId, raw)
			if (parsed !== undefined) events.push(parsed)
		}
	}

	const invites: SyncInvite[] = Object.entries(asRecord(rooms.invite)).map(([roomId, room]) => {
		const inviter = parseInviter(room, botUser)
		return inviter === undefined ? { roomId } : { roomId, inviter }
	})

	return {
		nextBatch,
		events,
		prevBatch,
		invites,
		joinedRooms,
		leftRooms: Object.keys(asRecord(rooms.leave)),
		displayNames
	}
}

function describe(op: string, status: number, errcode: string | undefined): string {
	return `${op} failed: status ${status}${errcode === undefined ? '' : ` (${errcode})`}`
}

export function createMatrixClient(opts: MatrixClientOptions): MatrixClient {
	const log = opts.log ?? (() => {})

	function fail(err: MatrixErr): MatrixErr {
		log(err.message)
		return err
	}

	async function request(spec: RequestSpec): Promise<MatrixResult<Record<string, unknown>>> {
		const url = new URL(spec.path, opts.baseUrl)
		if (spec.asUser !== undefined) url.searchParams.set('user_id', spec.asUser)
		for (const [k, v] of Object.entries(spec.query ?? {})) url.searchParams.set(k, v)

		let response: HttpResponse
		try {
			response = await opts.fetch(url.toString(), {
				method: spec.method,
				headers: {
					Authorization: `Bearer ${opts.token}`,
					'Content-Type': 'application/json'
				},
				body: spec.body === undefined ? undefined : JSON.stringify(spec.body)
			})
		} catch {
			// Deliberately nothing from the thrown value: a transport error can quote the
			// request it was making, headers included.
			return fail({ ok: false, kind: 'network', message: `${spec.op} failed: transport failure` })
		}

		let raw: string
		try {
			raw = await response.text()
		} catch {
			return fail({ ok: false, kind: 'network', message: `${spec.op} failed: unreadable body` })
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			parsed = undefined
		}
		const body = isPlainObject(parsed) ? parsed : undefined
		const errcode = typeof body?.errcode === 'string' ? body.errcode : undefined

		if (response.status >= 200 && response.status < 300) {
			if (body === undefined) {
				return fail({
					ok: false,
					kind: 'network',
					status: response.status,
					message: `${spec.op} failed: malformed response body`
				})
			}
			return { ok: true, value: body }
		}

		const message = describe(spec.op, response.status, errcode)
		if (response.status === 401 || response.status === 403) {
			return fail({ ok: false, kind: 'auth', status: response.status, errcode, message })
		}
		if (response.status === 429) {
			const retry = body?.retry_after_ms
			return fail({
				ok: false,
				kind: 'rate_limited',
				status: response.status,
				errcode,
				retryAfterMs: typeof retry === 'number' ? retry : undefined,
				message
			})
		}
		if (response.status >= 500) {
			return fail({ ok: false, kind: 'server', status: response.status, errcode, message })
		}
		return fail({ ok: false, kind: 'matrix', status: response.status, errcode, message })
	}

	function toVoid(result: MatrixResult<Record<string, unknown>>): MatrixResult<void> {
		return result.ok ? { ok: true, value: undefined } : result
	}

	function toRoom(
		op: string,
		result: MatrixResult<Record<string, unknown>>
	): MatrixResult<RoomRef> {
		if (!result.ok) return result
		const roomId = result.value.room_id
		if (typeof roomId !== 'string') {
			return fail({ ok: false, kind: 'network', message: `${op} failed: no room id in response` })
		}
		return { ok: true, value: { roomId } }
	}

	function creationBody(req: CreateRoomRequest, space: boolean): Record<string, unknown> {
		const body: Record<string, unknown> = {
			room_alias_name: localpartOf(req.alias),
			// Invite-only and unencrypted: nothing here ever asks for encryption, and a durable
			// record the sessions cannot read back would defeat the point of keeping one.
			preset: 'private_chat',
			visibility: 'private',
			initial_state: [
				{
					type: 'm.room.history_visibility',
					state_key: '',
					content: { history_visibility: 'shared' }
				},
				{ type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } }
			]
		}
		if (req.name !== undefined) body.name = req.name
		if (req.topic !== undefined) body.topic = req.topic
		if (req.invite !== undefined && req.invite.length > 0) body.invite = req.invite
		if (space) body.creation_content = { type: 'm.space' }
		return body
	}

	function create(
		req: CreateRoomRequest,
		asUser: string,
		space: boolean
	): Promise<MatrixResult<RoomRef>> {
		const op = space ? 'createSpace' : 'createRoom'
		return request({
			method: 'POST',
			path: `${API}/createRoom`,
			op,
			asUser,
			// No transaction id: room creation has none in the client-server API, so one would
			// be an ignored parameter that makes creation look retry-safe when it is not. A
			// repeated create is made safe by adopting the alias it collides with.
			body: creationBody(req, space)
		}).then((r) => toRoom(op, r))
	}

	return {
		registerUser: (userId) =>
			request({
				method: 'POST',
				path: `${API}/register`,
				op: 'registerUser',
				// No actor: the account being created cannot be acted as. This is the only
				// unattributed call the client makes.
				body: {
					type: 'm.login.application_service',
					username: localpartOf(userId),
					// Never mint a device or an access token: everything acts through the
					// appservice credential, so a login would leave one unused device per
					// identity and one more secret in existence with no holder.
					inhibit_login: true
				}
			}).then(toVoid),

		setDisplayName: (userId, displayName, asUser) =>
			request({
				method: 'PUT',
				path: `${API}/profile/${encodeURIComponent(userId)}/displayname`,
				op: 'setDisplayName',
				asUser,
				body: { displayname: displayName }
			}).then(toVoid),

		createRoom: (req, asUser) => create(req, asUser, false),
		createSpace: (req, asUser) => create(req, asUser, true),

		resolveAlias: (alias, asUser) =>
			request({
				method: 'GET',
				path: `${API}/directory/room/${encodeURIComponent(alias)}`,
				op: 'resolveAlias',
				asUser
			}).then((r) => toRoom('resolveAlias', r)),

		joinRoom: (roomIdOrAlias, asUser) =>
			request({
				method: 'POST',
				path: `${API}/join/${encodeURIComponent(roomIdOrAlias)}`,
				op: 'joinRoom',
				asUser,
				body: {}
			}).then((r) => toRoom('joinRoom', r)),

		invite: (roomId, userId, asUser) =>
			request({
				method: 'POST',
				path: `${API}/rooms/${encodeURIComponent(roomId)}/invite`,
				op: 'invite',
				asUser,
				body: { user_id: userId }
			}).then(toVoid),

		linkSpaceChild: (spaceId, childRoomId, asUser) =>
			request({
				method: 'PUT',
				path: `${API}/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childRoomId)}`,
				op: 'linkSpaceChild',
				asUser,
				body: { via: [domainOf(childRoomId)] }
			}).then(toVoid),

		sync: (opts, asUser) => {
			const query: Record<string, string> = {}
			if (opts.since !== undefined) query.since = opts.since
			if (opts.timeoutMs !== undefined) query.timeout = String(opts.timeoutMs)
			// A server-side filter, so an empty timeline costs no bandwidth rather than being
			// fetched and discarded.
			if (opts.emptyTimeline === true)
				query.filter = JSON.stringify({ room: { timeline: { limit: 0 } } })
			return request({ method: 'GET', path: `${API}/sync`, op: 'sync', asUser, query }).then(
				(r) => {
					if (!r.ok) return r
					const batch = parseSyncBatch(r.value, asUser)
					if (batch === undefined) {
						return fail({
							ok: false,
							kind: 'network',
							message: 'sync failed: no next batch in response'
						})
					}
					return { ok: true, value: batch }
				}
			)
		},

		leaveRoom: (roomId, asUser) =>
			request({
				method: 'POST',
				path: `${API}/rooms/${encodeURIComponent(roomId)}/leave`,
				op: 'leaveRoom',
				asUser,
				body: {}
			}).then(toVoid),

		roomMessages: (req, asUser) => {
			const query: Record<string, string> = { dir: req.dir ?? 'f' }
			if (req.from !== undefined) query.from = req.from
			if (req.limit !== undefined) query.limit = String(req.limit)
			return request({
				method: 'GET',
				path: `${API}/rooms/${encodeURIComponent(req.roomId)}/messages`,
				op: 'roomMessages',
				asUser,
				query
			}).then((r) => {
				if (!r.ok) return r
				const events: InboundEvent[] = []
				for (const raw of asArray(r.value.chunk)) {
					const parsed = parseEvent(req.roomId, raw)
					if (parsed !== undefined) events.push(parsed)
				}
				return { ok: true, value: { events, end: asString(r.value.end) } }
			})
		},

		sendMessage: (req, asUser) => {
			const body: Record<string, unknown> = { msgtype: 'm.text', body: req.text }
			if (req.threadRootEventId !== undefined) {
				body['m.relates_to'] = { rel_type: 'm.thread', event_id: req.threadRootEventId }
			}
			if (req.mentions !== undefined) {
				const mentions: Record<string, unknown> = {}
				if (req.mentions.userIds.length > 0) mentions.user_ids = req.mentions.userIds
				if (req.mentions.room) mentions.room = true
				body['m.mentions'] = mentions
			}
			return request({
				method: 'PUT',
				path: `${API}/rooms/${encodeURIComponent(req.roomId)}/send/m.room.message/${encodeURIComponent(req.txnId)}`,
				op: 'sendMessage',
				asUser,
				body
			}).then((r) => (r.ok ? { ok: true, value: { eventId: asString(r.value.event_id) } } : r))
		},

		listJoinedRooms: (asUser) =>
			request({
				method: 'GET',
				path: `${API}/joined_rooms`,
				op: 'listJoinedRooms',
				asUser
			}).then((r) => {
				if (!r.ok) return r
				const rooms = r.value.joined_rooms
				if (!Array.isArray(rooms) || rooms.some((x) => typeof x !== 'string')) {
					return fail({
						ok: false,
						kind: 'network',
						message: 'listJoinedRooms failed: malformed response body'
					})
				}
				return { ok: true, value: { rooms: rooms.filter((x) => typeof x === 'string') } }
			})
	}
}
