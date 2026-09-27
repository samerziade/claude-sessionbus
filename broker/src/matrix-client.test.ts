import { describe, expect, it } from 'vitest'
import {
	createMatrixClient,
	type FetchLike,
	type HttpRequest,
	type MatrixClient,
	type MatrixResult
} from './matrix-client.ts'

const BASE = 'https://hs.example'
const TOKEN = 'syt-distinctive-appservice-token-9f3a'
const BRIDGE = '@cc.bridge:host.example'
const WORKER = '@cc.sessionbus.w.123:host.example'

interface Captured {
	url: string
	init: HttpRequest
}

interface Reply {
	status: number
	body: string
}

interface Harness {
	calls: Captured[]
	client: MatrixClient
	logs: string[]
}

/** Build a client over a scripted transport. `reply` sees the zero-based call number. */
function harness(reply: (n: number) => Reply | Error): Harness {
	const calls: Captured[] = []
	const logs: string[] = []
	const fetch: FetchLike = async (url, init) => {
		const n = calls.length
		calls.push({ url, init })
		const r = reply(n)
		if (r instanceof Error) throw r
		return { status: r.status, text: async () => r.body }
	}
	const client = createMatrixClient({
		fetch,
		baseUrl: BASE,
		token: TOKEN,
		log: (m) => logs.push(m)
	})
	return { calls, client, logs }
}

function always(status: number, body = '{}'): (n: number) => Reply {
	return () => ({ status, body })
}

function actorOf(call: Captured): string | null {
	return new URL(call.url).searchParams.get('user_id')
}

function bodyOf(call: Captured): Record<string, unknown> {
	return JSON.parse(call.init.body ?? '{}')
}

function failure(result: MatrixResult<unknown>): {
	kind: string
	status?: number
	errcode?: string
	retryAfterMs?: number
} {
	if (result.ok) throw new Error('expected a failure')
	return {
		kind: result.kind,
		status: result.status,
		errcode: result.errcode,
		retryAfterMs: result.retryAfterMs
	}
}

describe('matrix client (success)', () => {
	it('resolves a 200 with a JSON body to a success carrying the parsed value', async () => {
		const h = harness(always(200, JSON.stringify({ room_id: '!abc:host.example' })))

		const result = await h.client.createRoom({ alias: '#cc.p.lobby:host.example' }, BRIDGE)

		expect(result).toEqual({ ok: true, value: { roomId: '!abc:host.example' } })
	})

	it('names a session identity as the actor on its behalf', async () => {
		const h = harness(always(200, JSON.stringify({ room_id: '!r:host.example' })))

		await h.client.joinRoom('!r:host.example', WORKER)

		expect(actorOf(h.calls[0])).toBe(WORKER)
	})

	it('names the bridge own user as the actor when creating, joining and inviting', async () => {
		const h = harness(always(200, JSON.stringify({ room_id: '!r:host.example' })))

		await h.client.createRoom({ alias: '#cc.p:host.example' }, BRIDGE)
		await h.client.createSpace({ alias: '#cc.p:host.example' }, BRIDGE)
		await h.client.joinRoom('!r:host.example', BRIDGE)
		await h.client.invite('!r:host.example', WORKER, BRIDGE)
		await h.client.linkSpaceChild('!s:host.example', '!r:host.example', BRIDGE)
		await h.client.listJoinedRooms(BRIDGE)
		await h.client.resolveAlias('#cc.p:host.example', BRIDGE)

		expect(h.calls.map(actorOf)).toEqual(Array(7).fill(BRIDGE))
	})

	it('marks a space create as a space and an ordinary create as not one', async () => {
		const h = harness(always(200, JSON.stringify({ room_id: '!r:host.example' })))

		await h.client.createSpace({ alias: '#cc.p:host.example' }, BRIDGE)
		await h.client.createRoom({ alias: '#cc.p.lobby:host.example' }, BRIDGE)

		expect(bodyOf(h.calls[0]).creation_content).toEqual({ type: 'm.space' })
		expect(bodyOf(h.calls[1]).creation_content).toBeUndefined()
	})

	it('asks for an invite-only, unencrypted room readable by later joiners', async () => {
		const h = harness(always(200, JSON.stringify({ room_id: '!r:host.example' })))

		await h.client.createRoom({ alias: '#cc.p.lobby:host.example' }, BRIDGE)

		const body = bodyOf(h.calls[0])
		expect(body.preset).toBe('private_chat')
		expect(body.visibility).toBe('private')
		expect(body.initial_state).toContainEqual({
			type: 'm.room.history_visibility',
			state_key: '',
			content: { history_visibility: 'shared' }
		})
		expect(body.initial_state).toContainEqual({
			type: 'm.room.join_rules',
			state_key: '',
			content: { join_rule: 'invite' }
		})
		expect(JSON.stringify(body)).not.toContain('m.room.encryption')
	})

	it('carries the operator invite on the creation request itself', async () => {
		const h = harness(always(200, JSON.stringify({ room_id: '!r:host.example' })))

		await h.client.createRoom(
			{ alias: '#cc.p.lobby:host.example', invite: ['@op:host.example'] },
			BRIDGE
		)

		expect(bodyOf(h.calls[0]).invite).toEqual(['@op:host.example'])
	})

	it('sends no transaction id on a creation call', async () => {
		// Room creation has no transaction id in the client-server API. Sending one would be a
		// parameter the homeserver ignores, and a reader would take creation for retry-safe on
		// the strength of it; retry safety comes from adopting an alias that is already claimed.
		const h = harness(always(200, JSON.stringify({ room_id: '!r:host.example' })))

		await h.client.createRoom({ alias: '#cc.p.lobby:host.example' }, BRIDGE)
		await h.client.createSpace({ alias: '#cc.p:host.example' }, BRIDGE)

		for (const call of h.calls) {
			expect(new URL(call.url).searchParams.get('txn_id')).toBeNull()
			expect(JSON.stringify(bodyOf(call))).not.toContain('txn')
		}
	})

	it('registers a user unattributed, without a password and without logging it in', async () => {
		const h = harness(always(200))

		await h.client.registerUser(WORKER)

		const call = h.calls[0]
		expect(actorOf(call)).toBeNull()
		expect(bodyOf(call)).toEqual({
			type: 'm.login.application_service',
			username: 'cc.sessionbus.w.123',
			inhibit_login: true
		})
		expect(call.init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
		expect(bodyOf(call).password).toBeUndefined()
	})

	it('never omits inhibit_login from any registration', async () => {
		const h = harness(always(200))

		await h.client.registerUser(WORKER)
		await h.client.registerUser(BRIDGE)

		for (const call of h.calls) expect(bodyOf(call).inhibit_login).toBe(true)
	})

	it('sets a display name as the user it belongs to', async () => {
		const h = harness(always(200))

		const result = await h.client.setDisplayName(WORKER, '123 epic:42', WORKER)

		expect(result.ok).toBe(true)
		expect(actorOf(h.calls[0])).toBe(WORKER)
		expect(bodyOf(h.calls[0])).toEqual({ displayname: '123 epic:42' })
	})

	it('returns the joined room list', async () => {
		const h = harness(always(200, JSON.stringify({ joined_rooms: ['!a:host.example'] })))

		const result = await h.client.listJoinedRooms(BRIDGE)

		expect(result).toEqual({ ok: true, value: { rooms: ['!a:host.example'] } })
	})
})

describe('matrix client (failures)', () => {
	it('maps 401 and 403 to an authentication failure', async () => {
		const a = harness(always(401, JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN' })))
		const b = harness(always(403, JSON.stringify({ errcode: 'M_FORBIDDEN' })))

		expect(failure(await a.client.listJoinedRooms(BRIDGE)).kind).toBe('auth')
		expect(failure(await b.client.listJoinedRooms(BRIDGE)).kind).toBe('auth')
	})

	it('maps 429 to a rate-limited failure carrying the server delay', async () => {
		const h = harness(
			always(429, JSON.stringify({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1500 }))
		)

		expect(failure(await h.client.registerUser(WORKER))).toEqual({
			kind: 'rate_limited',
			status: 429,
			errcode: 'M_LIMIT_EXCEEDED',
			retryAfterMs: 1500
		})
	})

	it('maps 500 to a server failure', async () => {
		const h = harness(always(500, '{}'))

		expect(failure(await h.client.registerUser(WORKER)).kind).toBe('server')
	})

	it('maps a rejecting transport to a transport failure, with no exception escaping', async () => {
		const h = harness(() => new Error('ECONNREFUSED'))

		const result = await h.client.registerUser(WORKER)

		expect(failure(result).kind).toBe('network')
	})

	it('maps another 4xx to a protocol failure carrying the server error code', async () => {
		const h = harness(always(400, JSON.stringify({ errcode: 'M_USER_IN_USE' })))

		expect(failure(await h.client.registerUser(WORKER))).toEqual({
			kind: 'matrix',
			status: 400,
			errcode: 'M_USER_IN_USE',
			retryAfterMs: undefined
		})
	})

	it('keeps the five failure kinds mutually distinct', async () => {
		const kinds: string[] = []
		for (const script of [
			always(401),
			always(429, JSON.stringify({ retry_after_ms: 10 })),
			always(500),
			always(400, JSON.stringify({ errcode: 'M_USER_IN_USE' }))
		]) {
			kinds.push(failure(await harness(script).client.registerUser(WORKER)).kind)
		}
		kinds.push(failure(await harness(() => new Error('down')).client.registerUser(WORKER)).kind)

		expect(new Set(kinds).size).toBe(5)
	})
})

describe('matrix client (edges)', () => {
	it('treats a 200 whose body is not JSON as a failure rather than throwing', async () => {
		const h = harness(always(200, '<html>gateway</html>'))

		const result = await h.client.createRoom({ alias: '#a:host.example' }, BRIDGE)

		expect(result.ok).toBe(false)
	})

	it('still types a 4xx that carries an empty body', async () => {
		const h = harness(always(404, ''))

		expect(failure(await h.client.resolveAlias('#a:host.example', BRIDGE))).toEqual({
			kind: 'matrix',
			status: 404,
			errcode: undefined,
			retryAfterMs: undefined
		})
	})

	it('treats a 200 with an empty body as a failure, not as an empty success', async () => {
		const h = harness(always(200, ''))

		expect(failure(await h.client.registerUser(WORKER)).kind).toBe('network')
	})
})

describe('matrix client (token leak)', () => {
	it('keeps the token out of every failure and every log line', async () => {
		const scripts: Array<(n: number) => Reply | Error> = [
			always(401, JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN' })),
			always(429, JSON.stringify({ retry_after_ms: 100 })),
			always(500, '{}'),
			always(200, 'not json'),
			() => new Error(`connect failed while presenting ${TOKEN}`)
		]

		for (const script of scripts) {
			const h = harness(script)
			const results = [
				await h.client.registerUser(WORKER),
				await h.client.createRoom({ alias: '#a:host.example' }, BRIDGE),
				await h.client.joinRoom('!r:host.example', BRIDGE),
				await h.client.invite('!r:host.example', WORKER, BRIDGE),
				await h.client.setDisplayName(WORKER, 'title', WORKER),
				await h.client.resolveAlias('#a:host.example', BRIDGE),
				await h.client.listJoinedRooms(BRIDGE),
				await h.client.linkSpaceChild('!s:host.example', '!r:host.example', BRIDGE)
			]
			for (const result of results) {
				expect(result.ok).toBe(false)
				expect(JSON.stringify(result)).not.toContain(TOKEN)
			}
			expect(h.logs.length).toBeGreaterThan(0)
			for (const line of h.logs) expect(line).not.toContain(TOKEN)
		}
	})
})

describe('sync', () => {
	function syncBody(over: Record<string, unknown> = {}): string {
		return JSON.stringify({ next_batch: 's-2', ...over })
	}

	it('acts as the user it was given, never unattributed', async () => {
		const h = harness(always(200, syncBody()))
		await h.client.sync({}, BRIDGE)

		expect(actorOf(h.calls[0])).toBe(BRIDGE)
	})

	it('carries the resume position and the long-poll timeout', async () => {
		const h = harness(always(200, syncBody()))
		await h.client.sync({ since: 's-1', timeoutMs: 30_000 }, BRIDGE)

		const url = new URL(h.calls[0].url)
		expect(url.searchParams.get('since')).toBe('s-1')
		expect(url.searchParams.get('timeout')).toBe('30000')
	})

	it('omits since when there is no position to resume from', async () => {
		const h = harness(always(200, syncBody()))
		await h.client.sync({}, BRIDGE)

		expect(new URL(h.calls[0].url).searchParams.has('since')).toBe(false)
	})

	it('asks for an empty timeline when reconciling', async () => {
		const h = harness(always(200, syncBody()))
		await h.client.sync({ emptyTimeline: true }, BRIDGE)

		const filter = new URL(h.calls[0].url).searchParams.get('filter')
		expect(filter).not.toBeNull()
		expect(JSON.parse(filter ?? '{}')).toMatchObject({ room: { timeline: { limit: 0 } } })
	})

	it('parses a text message with its mentions, thread and timestamp', async () => {
		const h = harness(
			always(
				200,
				syncBody({
					rooms: {
						join: {
							'!epic:host': {
								timeline: {
									prev_batch: 's-1',
									events: [
										{
											event_id: '$e1',
											sender: '@samer:host',
											type: 'm.room.message',
											origin_server_ts: 1700,
											content: {
												msgtype: 'm.text',
												body: 'hey',
												'm.mentions': { user_ids: [WORKER], room: false },
												'm.relates_to': { rel_type: 'm.thread', event_id: '$root' }
											}
										}
									]
								}
							}
						}
					}
				})
			)
		)
		const result = await h.client.sync({}, BRIDGE)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.nextBatch).toBe('s-2')
		expect(result.value.prevBatch).toEqual({ '!epic:host': 's-1' })
		expect(result.value.events).toEqual([
			{
				eventId: '$e1',
				roomId: '!epic:host',
				sender: '@samer:host',
				type: 'm.room.message',
				msgtype: 'm.text',
				body: 'hey',
				at: 1700,
				threadRootEventId: '$root',
				mentionedUserIds: [WORKER],
				mentionsRoom: false
			}
		])
	})

	it('reads a room-wide mention and a message with no mentions field', async () => {
		const h = harness(
			always(
				200,
				syncBody({
					rooms: {
						join: {
							'!epic:host': {
								timeline: {
									events: [
										{
											event_id: '$a',
											sender: '@samer:host',
											type: 'm.room.message',
											origin_server_ts: 1,
											content: { msgtype: 'm.text', body: 'all', 'm.mentions': { room: true } }
										},
										{
											event_id: '$b',
											sender: '@samer:host',
											type: 'm.room.message',
											origin_server_ts: 2,
											content: { msgtype: 'm.text', body: 'quiet' }
										}
									]
								}
							}
						}
					}
				})
			)
		)
		const result = await h.client.sync({}, BRIDGE)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.events[0].mentionsRoom).toBe(true)
		expect(result.value.events[1]).toMatchObject({ mentionsRoom: false, mentionedUserIds: [] })
	})

	it('reports an invite with the sender of the bot’s own membership event', async () => {
		const h = harness(
			always(
				200,
				syncBody({
					rooms: {
						invite: {
							'!root:host': {
								invite_state: {
									events: [
										{
											type: 'm.room.member',
											state_key: BRIDGE,
											sender: '@samer:host',
											content: { membership: 'invite', displayname: 'bridge' }
										},
										{ type: 'm.room.name', state_key: '', sender: '@samer:host', content: {} }
									]
								}
							}
						}
					}
				})
			)
		)
		const result = await h.client.sync({}, BRIDGE)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.invites).toEqual([{ roomId: '!root:host', inviter: '@samer:host' }])
	})

	it('reports an invite it cannot attribute rather than dropping it', async () => {
		const h = harness(
			always(
				200,
				syncBody({
					rooms: { invite: { '!root:host': { invite_state: { events: [] } } } }
				})
			)
		)
		const result = await h.client.sync({}, BRIDGE)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.invites).toEqual([{ roomId: '!root:host' }])
	})

	it('reports joined and left rooms', async () => {
		const h = harness(
			always(
				200,
				syncBody({
					rooms: { join: { '!a:host': {} }, leave: { '!b:host': {} } }
				})
			)
		)
		const result = await h.client.sync({}, BRIDGE)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.joinedRooms).toEqual(['!a:host'])
		expect(result.value.leftRooms).toEqual(['!b:host'])
	})

	it('collects display names from member events in the timeline and the state', async () => {
		const h = harness(
			always(
				200,
				syncBody({
					rooms: {
						join: {
							'!epic:host': {
								state: {
									events: [
										{
											event_id: '$m1',
											type: 'm.room.member',
											state_key: '@samer:host',
											sender: '@samer:host',
											origin_server_ts: 1,
											content: { membership: 'join', displayname: 'Samer Z' }
										}
									]
								},
								timeline: { events: [] }
							}
						}
					}
				})
			)
		)
		const result = await h.client.sync({}, BRIDGE)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.displayNames).toEqual({ '@samer:host': 'Samer Z' })
	})

	it('survives a batch whose rooms are missing or malformed', async () => {
		const h = harness(always(200, JSON.stringify({ next_batch: 's-2', rooms: 'nonsense' })))
		const result = await h.client.sync({}, BRIDGE)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value).toMatchObject({ nextBatch: 's-2', events: [], invites: [] })
	})

	it('fails rather than inventing a position when the response has none', async () => {
		const h = harness(always(200, '{}'))
		const result = await h.client.sync({}, BRIDGE)

		expect(result.ok).toBe(false)
	})

	it('returns a typed failure for a server error instead of throwing', async () => {
		const h = harness(always(500, '{"errcode":"M_UNKNOWN"}'))
		const result = await h.client.sync({}, BRIDGE)

		expect(result).toMatchObject({ ok: false, kind: 'server' })
	})
})

describe('leaveRoom', () => {
	it('leaves as the user it was given', async () => {
		const h = harness(always(200))
		const result = await h.client.leaveRoom('!root:host', BRIDGE)

		expect(result.ok).toBe(true)
		expect(actorOf(h.calls[0])).toBe(BRIDGE)
		expect(h.calls[0].url).toContain(`/rooms/${encodeURIComponent('!root:host')}/leave`)
	})
})

describe('roomMessages', () => {
	it('pages forward from a token as the user it was given', async () => {
		const h = harness(always(200, JSON.stringify({ chunk: [], start: 's-1', end: 's-2' })))
		await h.client.roomMessages({ roomId: '!epic:host', from: 's-1', limit: 30 }, BRIDGE)

		const url = new URL(h.calls[0].url)
		expect(actorOf(h.calls[0])).toBe(BRIDGE)
		expect(url.searchParams.get('from')).toBe('s-1')
		expect(url.searchParams.get('dir')).toBe('f')
		expect(url.searchParams.get('limit')).toBe('30')
	})

	it('pages backwards when asked, which is how recent history is read', async () => {
		const h = harness(always(200, JSON.stringify({ chunk: [], end: 's-2' })))
		await h.client.roomMessages({ roomId: '!epic:host', dir: 'b' }, BRIDGE)

		const url = new URL(h.calls[0].url)
		expect(url.searchParams.get('dir')).toBe('b')
		expect(url.searchParams.has('from')).toBe(false)
	})

	it('parses the chunk into messages and reports the end token', async () => {
		const h = harness(
			always(
				200,
				JSON.stringify({
					chunk: [
						{
							event_id: '$a',
							sender: '@samer:host',
							type: 'm.room.message',
							origin_server_ts: 5,
							content: { msgtype: 'm.text', body: 'hey' }
						}
					],
					end: 's-9'
				})
			)
		)
		const result = await h.client.roomMessages({ roomId: '!epic:host' }, BRIDGE)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.end).toBe('s-9')
		expect(result.value.events).toHaveLength(1)
		expect(result.value.events[0]).toMatchObject({ eventId: '$a', body: 'hey' })
	})
})

describe('sendMessage', () => {
	it('posts as the user it was given, with its transaction id in the path', async () => {
		const h = harness(always(200, JSON.stringify({ event_id: '$posted' })))
		const result = await h.client.sendMessage(
			{ roomId: '!epic:host', text: 'on it', txnId: 'zz-1' },
			WORKER
		)

		expect(result).toEqual({ ok: true, value: { eventId: '$posted' } })
		expect(actorOf(h.calls[0])).toBe(WORKER)
		expect(h.calls[0].url).toContain('/send/m.room.message/zz-1')
		expect(bodyOf(h.calls[0])).toMatchObject({ msgtype: 'm.text', body: 'on it' })
	})

	it('relates the post to a thread when one is named', async () => {
		const h = harness(always(200, JSON.stringify({ event_id: '$posted' })))
		await h.client.sendMessage(
			{ roomId: '!epic:host', text: 'on it', txnId: 'zz-1', threadRootEventId: '$root' },
			WORKER
		)

		expect(bodyOf(h.calls[0])['m.relates_to']).toEqual({
			rel_type: 'm.thread',
			event_id: '$root'
		})
	})

	it('names the users it mentions', async () => {
		const h = harness(always(200, JSON.stringify({ event_id: '$posted' })))
		await h.client.sendMessage(
			{
				roomId: '!epic:host',
				text: 'hi',
				txnId: 'zz-1',
				mentions: { userIds: ['@samer:host'], room: false }
			},
			WORKER
		)

		expect(bodyOf(h.calls[0])['m.mentions']).toEqual({ user_ids: ['@samer:host'] })
	})
})
