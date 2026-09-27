import { describe, expect, it } from 'vitest'
import type { HistoryQuery, HistoryResult } from '../../bus/src/mailbox.ts'
import { createMatrixClient, type FetchLike } from './matrix-client.ts'
import { createHistoryReader, type HistoryReader } from './matrix-history.ts'
import type { RelayIdentity } from './matrix-relay.ts'

const BASE = 'https://hs.example'
const BOT = '@cc.bridge:host'
const OPERATOR = '@samer:host'
const EPIC = '!epic:host'
const LOBBY = '!lobby:host'
const OTHER = '!other-epic:host'

const WORKER: RelayIdentity = {
	identity: 'proj/1234 epic:42',
	userId: '@cc.proj.w.1234:host',
	name: '1234 epic:42',
	epicRoomId: EPIC,
	lobbyRoomId: LOBBY
}
const LOBBY_ONLY: RelayIdentity = {
	identity: 'proj/notes',
	userId: '@cc.proj.s.notes:host',
	name: 'notes',
	lobbyRoomId: LOBBY
}

interface ChunkEvent {
	id: string
	sender?: string
	body?: string
	ts?: number
	thread?: string
	msgtype?: string
}

function chunkEvent(e: ChunkEvent): Record<string, unknown> {
	const content: Record<string, unknown> = {
		msgtype: e.msgtype ?? 'm.text',
		body: e.body ?? 'hello'
	}
	if (e.thread !== undefined) {
		content['m.relates_to'] = { rel_type: 'm.thread', event_id: e.thread }
	}
	return {
		event_id: e.id,
		sender: e.sender ?? OPERATOR,
		type: 'm.room.message',
		origin_server_ts: e.ts ?? 5,
		content
	}
}

interface Marked {
	identity: string
	room: string
	token: string
}

interface HistoryHarness {
	reader: HistoryReader
	requests: URL[]
	marked: Marked[]
	/** Messages served for the next page, newest last. */
	chunk: ChunkEvent[]
	end: string
	aliases: Map<string, string>
	rooms: Set<string>
}

function harness(opts: { identities?: RelayIdentity[]; maxLimit?: number } = {}): HistoryHarness {
	const requests: URL[] = []
	const marked: Marked[] = []
	const aliases = new Map<string, string>([['#cc.proj.epic.42:host', EPIC]])
	const rooms = new Set([EPIC, LOBBY, OTHER])
	const h: Partial<HistoryHarness> = { requests, marked, chunk: [], end: 's-9', aliases, rooms }

	const fetch: FetchLike = async (url) => {
		const parsed = new URL(url)
		requests.push(parsed)
		if (parsed.pathname.includes('/directory/room/')) {
			const alias = decodeURIComponent(parsed.pathname.split('/directory/room/')[1] ?? '')
			const roomId = aliases.get(alias)
			if (roomId === undefined) {
				return { status: 404, text: async () => '{"errcode":"M_NOT_FOUND"}' }
			}
			return { status: 200, text: async () => JSON.stringify({ room_id: roomId }) }
		}
		const dir = parsed.searchParams.get('dir')
		const events = (h.chunk ?? []).map(chunkEvent)
		return {
			status: 200,
			text: async () =>
				JSON.stringify({ chunk: dir === 'b' ? [...events].reverse() : events, end: h.end })
		}
	}

	const client = createMatrixClient({ fetch, baseUrl: BASE, token: 'tok' })
	h.reader = createHistoryReader({
		client,
		botUser: BOT,
		namespacePrefix: 'cc',
		identities: () => opts.identities ?? [WORKER, LOBBY_ONLY],
		isBridgeRoom: (roomId) => rooms.has(roomId),
		markRead: (identity, room, token) => marked.push({ identity, room, token }),
		maxLimit: opts.maxLimit
	})
	return h as HistoryHarness
}

function read(h: HistoryHarness, query: HistoryQuery = {}): Promise<HistoryResult> {
	return h.reader.read(WORKER.identity, query)
}

function messageRequests(h: HistoryHarness): URL[] {
	return h.requests.filter((u) => u.pathname.includes('/messages'))
}

describe('createHistoryReader (defaults)', () => {
	it("defaults to the caller's epic room", async () => {
		const h = harness()
		h.chunk = [{ id: '$a' }]

		const result = await read(h)

		expect(result).toMatchObject({ ok: true, room: EPIC })
	})

	it('defaults to the lobby for a caller with no epic', async () => {
		const h = harness()
		h.chunk = [{ id: '$a' }]

		const result = await h.reader.read(LOBBY_ONLY.identity, {})

		expect(result).toMatchObject({ ok: true, room: LOBBY })
	})

	it('makes every request as the bot', async () => {
		const h = harness()
		h.chunk = [{ id: '$a' }]

		await read(h, { room: '#cc.proj.epic.42:host' })

		expect(h.requests.length).toBeGreaterThan(1)
		for (const url of h.requests) expect(url.searchParams.get('user_id')).toBe(BOT)
	})

	it('resolves a namespace alias to its room', async () => {
		const h = harness()
		h.chunk = [{ id: '$a' }]

		expect(await read(h, { room: '#cc.proj.epic.42:host' })).toMatchObject({ ok: true, room: EPIC })
	})
})

describe('createHistoryReader (reading another group’s room)', () => {
	it('reads a room the caller is not a member of', async () => {
		const h = harness()
		h.chunk = [{ id: '$a', body: 'how we did it' }]

		const result = await read(h, { room: OTHER })

		expect(result).toMatchObject({ ok: true, room: OTHER })
		if (!result.ok) return
		expect(result.messages[0].text).toBe('how we did it')
	})

	it('records no cursor for a room the caller is not in', async () => {
		const h = harness()
		h.chunk = [{ id: '$a' }]

		await read(h, { room: OTHER })

		expect(h.marked).toEqual([])
	})

	it('advances the cursor for a room the caller is a member of', async () => {
		const h = harness()
		h.chunk = [{ id: '$a' }]
		h.end = 's-77'

		await read(h, { room: EPIC })

		expect(h.marked).toEqual([{ identity: WORKER.identity, room: EPIC, token: 's-77' }])
	})

	it('advances no cursor when the room held nothing to read', async () => {
		const h = harness()
		h.chunk = []

		await read(h, { room: EPIC })

		expect(h.marked).toEqual([])
	})
})

describe('createHistoryReader (paging and filters)', () => {
	it('pages forward from since so a truncated wake can be replayed', async () => {
		const h = harness()
		h.chunk = [
			{ id: '$1', body: 'dropped by the cap' },
			{ id: '$2', body: 'delivered' }
		]

		const result = await read(h, { room: EPIC, since: 's-1' })

		const request = messageRequests(h)[0]
		expect(request.searchParams.get('from')).toBe('s-1')
		expect(request.searchParams.get('dir')).toBe('f')
		if (!result.ok) return
		expect(result.messages.map((m) => m.text)).toEqual(['dropped by the cap', 'delivered'])
	})

	it('reads the most recent messages when no since is given', async () => {
		const h = harness()
		h.chunk = [
			{ id: '$1', body: 'older' },
			{ id: '$2', body: 'newest' }
		]

		const result = await read(h, { room: EPIC })

		expect(messageRequests(h)[0].searchParams.get('dir')).toBe('b')
		if (!result.ok) return
		// Oldest first, whichever direction the page was fetched in.
		expect(result.messages.map((m) => m.text)).toEqual(['older', 'newest'])
	})

	it('caps the page at limit and reports that more is waiting', async () => {
		const h = harness()
		h.chunk = [
			{ id: '$1', body: 'one' },
			{ id: '$2', body: 'two' },
			{ id: '$3', body: 'three' }
		]

		const result = await read(h, { room: EPIC, since: 's-1', limit: 2 })

		expect(result).toMatchObject({ ok: true, more: true })
		if (!result.ok) return
		expect(result.messages).toHaveLength(2)
	})

	it('reports no more when the room holds exactly the limit', async () => {
		const h = harness()
		h.chunk = [
			{ id: '$1', body: 'one' },
			{ id: '$2', body: 'two' }
		]

		expect(await read(h, { room: EPIC, since: 's-1', limit: 2 })).toMatchObject({
			ok: true,
			more: false
		})
	})

	it('clamps a limit above the maximum', async () => {
		const h = harness({ maxLimit: 3 })
		h.chunk = Array.from({ length: 10 }, (_, i) => ({ id: `$${i}`, body: `m${i}` }))

		const result = await read(h, { room: EPIC, since: 's-1', limit: 500 })

		if (!result.ok) return
		expect(result.messages).toHaveLength(3)
		expect(Number(messageRequests(h)[0].searchParams.get('limit'))).toBeLessThanOrEqual(4)
	})

	it('returns only the messages that match search', async () => {
		const h = harness()
		h.chunk = [
			{ id: '$1', body: 'the beacon keeper re-keys' },
			{ id: '$2', body: 'unrelated chatter' },
			{ id: '$3', body: 'BEACON again' }
		]

		const result = await read(h, { room: EPIC, since: 's-1', search: 'beacon' })

		if (!result.ok) return
		expect(result.messages.map((m) => m.text)).toEqual([
			'the beacon keeper re-keys',
			'BEACON again'
		])
	})

	it('returns only the messages of the named thread', async () => {
		const h = harness()
		h.chunk = [
			{ id: '$1', body: 'on the timeline' },
			{ id: '$2', body: 'in the thread', thread: '$root' }
		]
		const threaded = await read(h, { room: EPIC, since: 's-1' })
		if (!threaded.ok) return
		const handle = threaded.messages[1].thread ?? ''

		const result = await read(h, { room: EPIC, since: 's-1', thread: handle })

		if (!result.ok) return
		expect(result.messages.map((m) => m.text)).toEqual(['in the thread'])
	})
})

describe('createHistoryReader (negative)', () => {
	it('answers not_found for a room that does not exist', async () => {
		const h = harness()

		expect(await read(h, { room: '!nowhere:host' })).toEqual({ ok: false, reason: 'not_found' })
	})

	it('answers not_found for an alias outside the namespace', async () => {
		const h = harness()
		h.aliases.set('#general:host', '!general:host')

		expect(await read(h, { room: '#general:host' })).toEqual({ ok: false, reason: 'not_found' })
		expect(messageRequests(h)).toEqual([])
	})

	it('answers not_found for an alias nothing resolves', async () => {
		const h = harness()

		expect(await read(h, { room: '#cc.proj.epic.99:host' })).toEqual({
			ok: false,
			reason: 'not_found'
		})
	})

	it('answers not_found for a caller with no rooms at all', async () => {
		const h = harness({ identities: [{ identity: 'proj/none', userId: '@cc.proj.s.none:host' }] })

		expect(await h.reader.read('proj/none', {})).toEqual({ ok: false, reason: 'not_found' })
	})

	it('answers not_found for an identity it has never heard of', async () => {
		const h = harness()

		expect(await h.reader.read('nobody/at-all', {})).toEqual({ ok: false, reason: 'not_found' })
	})

	it('answers unavailable rather than throwing when the homeserver fails', async () => {
		const h = harness()
		h.end = 's-9'
		const failing = createHistoryReader({
			client: {
				roomMessages: async () => ({ ok: false, kind: 'server', message: 'boom' }),
				resolveAlias: async () => ({ ok: false, kind: 'server', message: 'boom' })
			},
			botUser: BOT,
			namespacePrefix: 'cc',
			identities: () => [WORKER],
			isBridgeRoom: () => true,
			markRead: () => {}
		})

		await expect(failing.read(WORKER.identity, { room: EPIC })).resolves.toEqual({
			ok: false,
			reason: 'unavailable'
		})
	})
})

describe('createHistoryReader (blind spots)', () => {
	it('returns an entry with exactly the declared keys', async () => {
		const h = harness()
		h.chunk = [{ id: '$a', body: 'ship it', ts: 1700 }]

		const result = await read(h, { room: EPIC })

		if (!result.ok) return
		expect(Object.keys(result.messages[0]).sort()).toEqual([
			'at',
			'from',
			'from_id',
			'origin',
			'text'
		])
		expect(result.messages[0]).toEqual({
			from: 'samer',
			from_id: OPERATOR,
			origin: 'human',
			text: 'ship it',
			at: 1700
		})
	})

	it('reports a namespace sender as session origin', async () => {
		const h = harness()
		h.chunk = [{ id: '$a', sender: WORKER.userId, body: 'on it' }]

		const result = await read(h, { room: EPIC })

		if (!result.ok) return
		expect(result.messages[0]).toMatchObject({ origin: 'session', from_id: WORKER.userId })
	})

	it('leaves out anything that is not a plain text message', async () => {
		const h = harness()
		h.chunk = [
			{ id: '$a', body: 'text' },
			{ id: '$b', body: 'a picture', msgtype: 'm.image' }
		]

		const result = await read(h, { room: EPIC })

		if (!result.ok) return
		expect(result.messages.map((m) => m.text)).toEqual(['text'])
	})

	it('never reaches a routing path: reading has no way to wake anyone', async () => {
		// Structural rather than behavioural: the reader is constructed with no route of any
		// kind, so a read cannot deliver to a session however it is called.
		const h = harness()
		h.chunk = [{ id: '$a' }]

		await read(h, { room: EPIC })

		expect(h.marked.map((m) => m.identity)).toEqual([WORKER.identity])
	})
})
