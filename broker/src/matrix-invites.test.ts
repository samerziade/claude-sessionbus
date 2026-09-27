import { describe, expect, it } from 'vitest'
import {
	createMatrixClient,
	type FetchLike,
	type HttpRequest,
	type SyncBatch
} from './matrix-client.ts'
import { createInviteHandler, decideInvite, type InviteHandler } from './matrix-invites.ts'

const BASE = 'https://hs.example'
const BOT = '@cc.bridge:host'
const OPERATOR = '@samer:host'
const STRANGER = '@mallory:host'
const ROOM = '!root:host'

interface Call {
	url: string
	init: HttpRequest
}

interface Harness {
	calls: Call[]
	handler: InviteHandler
	/** Rooms joined so far, in order, with the user each join acted as. */
	joins: { room: string; asUser: string | null }[]
	/** Rooms whose join will fail while they are in here. */
	fail: Set<string>
}

function handlerWith(opts: { operator?: string } = { operator: OPERATOR }): Harness {
	const calls: Call[] = []
	const fail = new Set<string>()
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url, init })
		const failing = [...fail].some((needle) => url.includes(encodeURIComponent(needle)))
		if (failing) return { status: 500, text: async () => '{"errcode":"M_UNKNOWN"}' }
		return { status: 200, text: async () => JSON.stringify({ room_id: ROOM }) }
	}
	const client = createMatrixClient({ fetch, baseUrl: BASE, token: 'tok' })
	const handler = createInviteHandler({ client, botUser: BOT, operator: opts.operator })
	return {
		calls,
		handler,
		fail,
		get joins() {
			return calls
				.filter((c) => c.url.includes('/join/'))
				.map((c) => ({
					room: decodeURIComponent(new URL(c.url).pathname.split('/join/')[1] ?? ''),
					asUser: new URL(c.url).searchParams.get('user_id')
				}))
		}
	}
}

function batch(over: Partial<SyncBatch> = {}): SyncBatch {
	return {
		nextBatch: 's-2',
		events: [],
		prevBatch: {},
		invites: [],
		joinedRooms: [],
		leftRooms: [],
		displayNames: {},
		...over
	}
}

function leavesIn(calls: Call[]): { room: string; asUser: string | null }[] {
	return calls
		.filter((c) => new URL(c.url).pathname.endsWith('/leave'))
		.map((c) => ({
			room: decodeURIComponent(new URL(c.url).pathname.split('/rooms/')[1]?.split('/')[0] ?? ''),
			asUser: new URL(c.url).searchParams.get('user_id')
		}))
}

describe('decideInvite', () => {
	it('accepts an invite whose sender is exactly the configured operator', () => {
		expect(decideInvite({ inviter: OPERATOR, operator: OPERATOR })).toBe('accept')
	})

	it('declines an invite from any other local user', () => {
		expect(decideInvite({ inviter: STRANGER, operator: OPERATOR })).toBe('decline')
	})

	it('ignores every invite when no operator is configured', () => {
		expect(decideInvite({ inviter: OPERATOR })).toBe('ignore')
		expect(decideInvite({ inviter: STRANGER, operator: '' })).toBe('ignore')
	})

	it('compares user ids, never display names', () => {
		// The impostor's display name is the operator's; only the sender id is consulted, and
		// the decision function is never even shown a display name to be fooled by.
		expect(decideInvite({ inviter: '@samer.impostor:host', operator: OPERATOR })).toBe('decline')
		expect(decideInvite({ inviter: '@samer:other', operator: OPERATOR })).toBe('decline')
		expect(decideInvite({ inviter: '@Samer:host', operator: OPERATOR })).toBe('decline')
	})

	it('ignores an invite it cannot attribute rather than destroying it', () => {
		expect(decideInvite({ operator: OPERATOR })).toBe('ignore')
	})
})

describe('createInviteHandler (happy path)', () => {
	it('joins an operator invite exactly once, as the bot, and declines nothing', async () => {
		const h = handlerWith()
		await h.handler.onBatch(batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] }))

		expect(h.joins).toEqual([{ room: ROOM, asUser: BOT }])
		expect(leavesIn(h.calls)).toEqual([])
	})
})

describe('createInviteHandler (negative)', () => {
	it('declines a non-operator invite by leaving, as the bot, and never joins', async () => {
		const h = handlerWith()
		await h.handler.onBatch(batch({ invites: [{ roomId: ROOM, inviter: STRANGER }] }))

		expect(h.joins).toEqual([])
		expect(leavesIn(h.calls)).toEqual([{ room: ROOM, asUser: BOT }])
	})

	it('joins one and declines the other when a batch carries both, each as the bot', async () => {
		const h = handlerWith()
		await h.handler.onBatch(
			batch({
				invites: [
					{ roomId: '!ok:host', inviter: OPERATOR },
					{ roomId: '!bad:host', inviter: STRANGER }
				]
			})
		)

		expect(h.joins).toEqual([{ room: '!ok:host', asUser: BOT }])
		expect(leavesIn(h.calls)).toEqual([{ room: '!bad:host', asUser: BOT }])
	})

	it('leaves an invite it cannot attribute pending, joining and declining nothing', async () => {
		const h = handlerWith()
		// No membership event for the bot in the stripped state, so there is no sender to
		// compare. Declining would destroy an invite the operator may well have sent.
		await h.handler.onBatch(batch({ invites: [{ roomId: ROOM }] }))

		expect(h.joins).toEqual([])
		expect(leavesIn(h.calls)).toEqual([])
	})

	it('joins nothing and declines nothing with no operator configured', async () => {
		const h = handlerWith({})
		await h.handler.onBatch(
			batch({
				invites: [
					{ roomId: '!ok:host', inviter: OPERATOR },
					{ roomId: '!bad:host', inviter: STRANGER }
				]
			})
		)

		expect(h.joins).toEqual([])
		expect(leavesIn(h.calls)).toEqual([])
	})

	it('never turns a failed join into a decline', async () => {
		const h = handlerWith()
		h.fail.add(ROOM)
		await h.handler.onBatch(batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] }))

		expect(h.joins).toHaveLength(1)
		expect(leavesIn(h.calls)).toEqual([])
	})

	it('does not decline the same room twice', async () => {
		const h = handlerWith()
		const withInvite = batch({ invites: [{ roomId: ROOM, inviter: STRANGER }] })
		await h.handler.onBatch(withInvite)
		await h.handler.onBatch(withInvite)

		expect(leavesIn(h.calls)).toHaveLength(1)
	})
})

describe('createInviteHandler (idempotency)', () => {
	it('issues no second join when the batch is replayed before the room shows as joined', async () => {
		const h = handlerWith()
		const withInvite = batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] })
		await h.handler.onBatch(withInvite)
		await h.handler.onBatch(withInvite)

		expect(h.joins).toHaveLength(1)
	})

	it('issues no join for a room the batch already reports as joined', async () => {
		const h = handlerWith()
		await h.handler.onBatch(
			batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }], joinedRooms: [ROOM] })
		)

		expect(h.joins).toEqual([])
	})

	it('shares one attempt when a second batch arrives while a join is in flight', async () => {
		const h = handlerWith()
		const withInvite = batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] })
		const first = h.handler.onBatch(withInvite)
		const second = h.handler.onBatch(withInvite)
		await Promise.all([first, second])

		expect(h.joins).toHaveLength(1)
	})
})

describe('createInviteHandler (retry)', () => {
	it('retries a failed join on the next sync iteration without the invite reappearing', async () => {
		const h = handlerWith()
		h.fail.add(ROOM)
		await h.handler.onBatch(batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] }))
		expect(h.joins).toHaveLength(1)

		h.fail.clear()
		await h.handler.onBatch(batch())

		expect(h.joins).toEqual([
			{ room: ROOM, asUser: BOT },
			{ room: ROOM, asUser: BOT }
		])
	})

	it('stops retrying once the join succeeds', async () => {
		const h = handlerWith()
		h.fail.add(ROOM)
		await h.handler.onBatch(batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] }))
		h.fail.clear()
		await h.handler.onBatch(batch())
		await h.handler.onBatch(batch())

		expect(h.joins).toHaveLength(2)
	})

	it('stops retrying when a later batch shows the invite withdrawn', async () => {
		const h = handlerWith()
		h.fail.add(ROOM)
		await h.handler.onBatch(batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] }))

		h.fail.clear()
		await h.handler.onBatch(batch({ leftRooms: [ROOM] }))
		await h.handler.onBatch(batch())

		expect(h.joins).toHaveLength(1)
	})

	it('reports what it still owes a join for', async () => {
		const h = handlerWith()
		h.fail.add(ROOM)
		await h.handler.onBatch(batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] }))

		expect(h.handler.pending()).toEqual([ROOM])
	})
})

describe('createInviteHandler (blind spots)', () => {
	it('never rejects across its boundary when the homeserver throws', async () => {
		const calls: string[] = []
		const fetch: FetchLike = async (url) => {
			calls.push(url)
			throw new Error('socket hang up')
		}
		const client = createMatrixClient({ fetch, baseUrl: BASE, token: 'tok' })
		const handler = createInviteHandler({ client, botUser: BOT, operator: OPERATOR })

		await expect(
			handler.onBatch(batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] }))
		).resolves.toBeUndefined()
		expect(handler.pending()).toEqual([ROOM])
	})

	it('joins a room again after leaving it and being re-invited', async () => {
		const h = handlerWith()
		await h.handler.onBatch(batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] }))
		await h.handler.onBatch(batch({ leftRooms: [ROOM] }))
		await h.handler.onBatch(batch({ invites: [{ roomId: ROOM, inviter: OPERATOR }] }))

		expect(h.joins).toHaveLength(2)
	})
})
