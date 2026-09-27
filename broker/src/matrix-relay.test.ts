import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChannelMessage } from '../../bus/src/message.ts'
import { type BridgeState, createBridgeState } from './bridge-state.ts'
import { createMatrixClient, type FetchLike } from './matrix-client.ts'
import {
	createMatrixRelay,
	type MatrixRelay,
	type RelayIdentity,
	resolveReplyTarget
} from './matrix-relay.ts'

const BASE = 'https://hs.example'
const BOT = '@cc.bridge:host'
const SENDER_IDENTITY = '@cc.appservice:host'
const OPERATOR = '@samer:host'
const EPIC = '!epic:host'
const LOBBY = '!lobby:host'

const WORKER: RelayIdentity = {
	identity: 'proj/1234 epic:42',
	userId: '@cc.proj.w.1234:host',
	name: '1234 epic:42',
	epicRoomId: EPIC,
	lobbyRoomId: LOBBY
}
const PM: RelayIdentity = {
	identity: 'proj/epic:42',
	userId: '@cc.proj.pm.42:host',
	name: 'epic:42',
	epicRoomId: EPIC,
	lobbyRoomId: LOBBY
}

const cleanups: Array<() => void> = []
afterEach(() => {
	for (const c of cleanups.splice(0)) c()
})

function tempStatePath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'relay-state-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	return join(dir, 'state.json')
}

interface TextEvent {
	id: string
	sender?: string
	body?: string
	mentions?: string[]
	mentionsRoom?: boolean
	ts?: number
	thread?: string
	type?: string
	msgtype?: string
}

function textEvent(e: TextEvent): Record<string, unknown> {
	const content: Record<string, unknown> = {
		msgtype: e.msgtype ?? 'm.text',
		body: e.body ?? 'hello'
	}
	if (e.mentions !== undefined || e.mentionsRoom !== undefined) {
		content['m.mentions'] = { user_ids: e.mentions ?? [], room: e.mentionsRoom ?? false }
	}
	if (e.thread !== undefined) {
		content['m.relates_to'] = { rel_type: 'm.thread', event_id: e.thread }
	}
	return {
		event_id: e.id,
		sender: e.sender ?? OPERATOR,
		type: e.type ?? 'm.room.message',
		origin_server_ts: e.ts ?? Date.UTC(2024, 0, 15, 14, 2),
		content
	}
}

interface BatchSpec {
	nextBatch: string
	rooms?: Record<string, { events?: TextEvent[]; prevBatch?: string }>
	invites?: Record<string, string>
	left?: string[]
	displayNames?: Record<string, string>
}

function syncBody(spec: BatchSpec): string {
	const join: Record<string, unknown> = {}
	for (const [roomId, room] of Object.entries(spec.rooms ?? {})) {
		const timeline: Record<string, unknown> = { events: (room.events ?? []).map(textEvent) }
		if (room.prevBatch !== undefined) timeline.prev_batch = room.prevBatch
		join[roomId] = {
			timeline,
			state: {
				events: Object.entries(spec.displayNames ?? {}).map(([userId, displayname]) => ({
					event_id: `$m-${userId}`,
					type: 'm.room.member',
					state_key: userId,
					sender: userId,
					origin_server_ts: 1,
					content: { membership: 'join', displayname }
				}))
			}
		}
	}
	const invite: Record<string, unknown> = {}
	for (const [roomId, inviter] of Object.entries(spec.invites ?? {})) {
		invite[roomId] = {
			invite_state: {
				events: [
					{
						type: 'm.room.member',
						state_key: BOT,
						sender: inviter,
						content: { membership: 'invite' }
					}
				]
			}
		}
	}
	const leave: Record<string, unknown> = {}
	for (const roomId of spec.left ?? []) leave[roomId] = {}
	return JSON.stringify({ next_batch: spec.nextBatch, rooms: { join, invite, leave } })
}

interface Routed {
	to: string
	msg: ChannelMessage
	/** The persisted sync position at the instant the wake was handed to `route`. */
	tokenAtRoute: string | undefined
}

interface RelayHarness {
	relay: MatrixRelay
	state: BridgeState
	routed: Routed[]
	/** Every request the relay issued, newest last. */
	requests: string[]
	/** Sync responses served in order; an exhausted queue serves an empty batch. */
	queue: string[]
	/** Overrides the next fetch outcome when set. */
	fail?: { status: number; body?: string } | 'throw'
	/** Replaced wholesale by a test, so a relay that snapshotted the list is caught. */
	setIdentities(next: RelayIdentity[]): void
	sessions: Map<string, string>
	now: { value: number }
}

interface HarnessOptions {
	statePath?: string
	identities?: RelayIdentity[]
	sessions?: Record<string, string>
	caps?: { messages: number; chars: number }
	operator?: string
}

function harness(opts: HarnessOptions = {}): RelayHarness {
	const requests: string[] = []
	const queue: string[] = []
	const routed: Routed[] = []
	let identities = opts.identities ?? [WORKER]
	const sessions = new Map(Object.entries(opts.sessions ?? { [WORKER.identity]: 'sess-1' }))
	const now = { value: 1_000 }
	const h: Partial<RelayHarness> = {}

	const fetch: FetchLike = async (url, _init) => {
		requests.push(url)
		if (h.fail === 'throw') throw new Error('socket hang up')
		if (h.fail !== undefined) {
			return {
				status: h.fail.status,
				text: async () => (h.fail === 'throw' ? '' : (h.fail?.body ?? '{}'))
			}
		}
		if (new URL(url).pathname.endsWith('/sync')) {
			const next = queue.shift() ?? syncBody({ nextBatch: 'idle' })
			return { status: 200, text: async () => next }
		}
		return { status: 200, text: async () => JSON.stringify({ room_id: '!joined:host' }) }
	}

	const state = createBridgeState({ path: opts.statePath ?? tempStatePath(), debounceMs: 0 })
	const record = (to: string, msg: ChannelMessage) => {
		routed.push({ to, msg, tokenAtRoute: state.getSyncToken(BOT) })
	}
	const client = createMatrixClient({ fetch, baseUrl: BASE, token: 'tok' })
	const relay = createMatrixRelay({
		client,
		state,
		route: record,
		identities: () => identities,
		sessionForIdentity: (identity) => sessions.get(identity),
		botUser: BOT,
		operator: 'operator' in opts ? opts.operator : OPERATOR,
		namespacePrefix: 'cc',
		caps: opts.caps ?? { messages: 20, chars: 2000 },
		now: () => now.value
	})

	Object.assign(h, {
		relay,
		state,
		routed,
		requests,
		queue,
		sessions,
		now,
		setIdentities: (next: RelayIdentity[]) => {
			identities = next
		}
	})
	return h as RelayHarness
}

function syncRequests(h: RelayHarness): URL[] {
	return h.requests.map((r) => new URL(r)).filter((u) => u.pathname.endsWith('/sync'))
}

/** Requests that open or advance the event stream — every sync but the reconciliation one. */
function streamRequests(h: RelayHarness): URL[] {
	return syncRequests(h).filter((u) => !u.searchParams.has('filter'))
}

describe('createMatrixRelay (happy path)', () => {
	it('resumes the stream from the persisted position', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }), syncBody({ nextBatch: 's-2' }))

		await h.relay.start()
		await h.relay.step()

		expect(streamRequests(h)[0].searchParams.get('since')).toBe('s-1')
	})

	it('acts as the bot on every request and never as the appservice sender identity', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(
			syncBody({ nextBatch: 's-recon', invites: { '!root:host': OPERATOR } }),
			syncBody({ nextBatch: 's-2', rooms: { [EPIC]: { events: [{ id: '$a' }] } } })
		)

		await h.relay.start()
		await h.relay.step()

		expect(h.requests.length).toBeGreaterThan(1)
		for (const url of h.requests) {
			expect(new URL(url).searchParams.get('user_id')).toBe(BOT)
			expect(new URL(url).searchParams.get('user_id')).not.toBe(SENDER_IDENTITY)
		}
	})

	it('routes exactly one wake to the mentioned identity’s current session id', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(
			syncBody({ nextBatch: 's-recon' }),
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$a', body: 'ship it', mentions: [WORKER.userId] }] } }
			})
		)

		await h.relay.start()
		await h.relay.step()

		expect(h.routed).toHaveLength(1)
		expect(h.routed[0].to).toBe('sess-1')
		expect(h.routed[0].msg.text).toContain('ship it')
		expect(h.routed[0].msg.from).toMatchObject({ origin: 'human', userId: OPERATOR, role: 'none' })
		expect(h.routed[0].msg.relay).toMatchObject({ room: EPIC, unread: 1, omitted: 0 })
	})

	it('names the human sender by display name where the stream reports one', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(
			syncBody({ nextBatch: 's-recon' }),
			syncBody({
				nextBatch: 's-2',
				displayNames: { [OPERATOR]: 'Samer Z' },
				rooms: { [EPIC]: { events: [{ id: '$a', mentions: [WORKER.userId] }] } }
			})
		)

		await h.relay.start()
		await h.relay.step()

		expect(h.routed[0].msg.from.name).toBe('Samer Z')
		expect(h.routed[0].msg.text).toContain('Samer Z:')
	})
})

describe('createMatrixRelay (cold start)', () => {
	it('starts at now and relays nothing that predates the start', async () => {
		const h = harness()
		// The reconciliation response carries a timeline anyway: nothing in it may be relayed,
		// whatever the homeserver chooses to send back.
		h.queue.push(
			syncBody({
				nextBatch: 's-5',
				rooms: { [EPIC]: { events: [{ id: '$old', mentions: [WORKER.userId] }] } }
			})
		)

		await h.relay.start()

		expect(h.routed).toEqual([])
		expect(h.state.getSyncToken(BOT)).toBe('s-5')
	})

	it('cold starts over a state store that cannot be parsed, without raising', async () => {
		const path = tempStatePath()
		writeFileSync(path, '{"sync":{"token":"s-1","bot')
		const h = harness({ statePath: path })
		h.queue.push(syncBody({ nextBatch: 's-5' }))

		await expect(h.relay.start()).resolves.toBeUndefined()
		expect(h.state.getSyncToken(BOT)).toBe('s-5')
	})

	it('discards a position recorded under another bot identity and cold starts', async () => {
		const path = tempStatePath()
		const seeded = createBridgeState({ path, debounceMs: 0 })
		seeded.setSyncToken('s-1', '@cc.bridge.old:host')
		seeded.flush()

		const h = harness({ statePath: path })
		h.queue.push(syncBody({ nextBatch: 's-5' }), syncBody({ nextBatch: 's-6' }))
		await h.relay.start()
		await h.relay.step()

		expect(h.state.getSyncToken(BOT)).toBe('s-6')
		expect(streamRequests(h)[0].searchParams.get('since')).toBe('s-5')
	})
})

describe('createMatrixRelay (one stream)', () => {
	it('observes every room through a single in-flight sync request', async () => {
		const h = harness({
			identities: [WORKER, PM],
			sessions: { [WORKER.identity]: 'sess-1', [PM.identity]: 'sess-2' }
		})
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(
			syncBody({ nextBatch: 's-recon' }),
			syncBody({
				nextBatch: 's-2',
				rooms: {
					[EPIC]: { events: [{ id: '$a', mentions: [WORKER.userId] }] },
					[LOBBY]: { events: [{ id: '$b', mentions: [PM.userId] }] }
				}
			})
		)

		await h.relay.start()
		const before = streamRequests(h).length
		// Two calls, no await between them: the second must find one already in flight.
		await Promise.all([h.relay.step(), h.relay.step()])

		expect(streamRequests(h).length).toBe(before + 1)
		expect(h.routed.map((r) => r.to).sort()).toEqual(['sess-1', 'sess-2'])
	})
})

describe('createMatrixRelay (the filter chain, wired in)', () => {
	async function started(h: RelayHarness): Promise<void> {
		h.state.setSyncToken('s-1', BOT)
		h.queue.unshift(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()
	}

	it('routes nothing for an event sent by a namespace user', async () => {
		const h = harness()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: {
					[EPIC]: { events: [{ id: '$a', sender: PM.userId, mentions: [WORKER.userId] }] }
				}
			})
		)
		await started(h)
		await h.relay.step()

		expect(h.routed).toEqual([])
	})

	it('routes one wake in total for an event id that arrives twice', async () => {
		const h = harness()
		const withMention = {
			nextBatch: 's-2',
			rooms: { [EPIC]: { events: [{ id: '$a', mentions: [WORKER.userId] }] } }
		}
		h.queue.push(syncBody(withMention), syncBody({ ...withMention, nextBatch: 's-3' }))
		await started(h)
		await h.relay.step()
		await h.relay.step()

		expect(h.routed).toHaveLength(1)
	})

	it('leaves every cursor alone for a batch the filter discards entirely', async () => {
		const h = harness()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: {
					[EPIC]: {
						events: [
							{ id: '$a', sender: PM.userId, mentions: [WORKER.userId] },
							{ id: '$b', type: 'm.reaction' }
						]
					}
				}
			})
		)
		await started(h)
		await h.relay.step()

		expect(h.state.getCursor(WORKER.identity, EPIC)).toBeUndefined()
		expect(h.routed).toEqual([])
	})
})

describe('createMatrixRelay (fan-out)', () => {
	async function twoIdentities(): Promise<RelayHarness> {
		const h = harness({
			identities: [WORKER, PM],
			sessions: { [WORKER.identity]: 'sess-1', [PM.identity]: 'sess-2' }
		})
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()
		return h
	}

	it('routes one wake per named identity, each with its own unread count', async () => {
		const h = await twoIdentities()
		// The PM has one message of backlog the worker has already been woken past.
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$w', mentions: [WORKER.userId] }] } }
			}),
			syncBody({
				nextBatch: 's-3',
				rooms: {
					[EPIC]: { events: [{ id: '$both', mentions: [WORKER.userId, PM.userId] }] }
				}
			})
		)
		await h.relay.step()
		await h.relay.step()

		const last = h.routed.slice(-2)
		expect(last.map((r) => r.to)).toEqual(['sess-1', 'sess-2'])
		expect(last[0].msg.relay?.unread).toBe(1)
		expect(last[1].msg.relay?.unread).toBe(2)
	})

	it("names the other identity in each wake's mentions and never itself", async () => {
		const h = await twoIdentities()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$both', mentions: [WORKER.userId, PM.userId] }] } }
			})
		)
		await h.relay.step()

		expect(h.routed[0].msg.relay?.mentions).toEqual([PM.name])
		expect(h.routed[1].msg.relay?.mentions).toEqual([WORKER.name])
	})

	it('omits mentions from a wake that named one identity', async () => {
		const h = await twoIdentities()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$w', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.step()

		expect(h.routed[0].msg.relay?.mentions).toBeUndefined()
	})

	it('wakes every registered member of the room on a room-wide mention', async () => {
		const h = await twoIdentities()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$all', mentionsRoom: true }] } }
			})
		)
		await h.relay.step()

		expect(h.routed.map((r) => r.to).sort()).toEqual(['sess-1', 'sess-2'])
	})

	it('processes one event once, however many it names', async () => {
		const h = await twoIdentities()
		const spec = {
			nextBatch: 's-2',
			rooms: { [EPIC]: { events: [{ id: '$both', mentions: [WORKER.userId, PM.userId] }] } }
		}
		h.queue.push(syncBody(spec), syncBody({ ...spec, nextBatch: 's-3' }))
		await h.relay.step()
		await h.relay.step()

		expect(h.routed).toHaveLength(2)
	})
})

describe('createMatrixRelay (negative)', () => {
	async function started(h: RelayHarness): Promise<RelayHarness> {
		h.state.setSyncToken('s-1', BOT)
		h.queue.unshift(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()
		return h
	}

	it('routes nothing and leaves the cursor alone for an identity with no live session', async () => {
		const h = harness({ sessions: {} })
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$a', mentions: [WORKER.userId] }] } }
			})
		)
		await started(h)
		await h.relay.step()

		expect(h.routed).toEqual([])
		expect(h.state.getCursor(WORKER.identity, EPIC)).toBeUndefined()
	})

	it('wakes the registered identity beside an unknown namespace name', async () => {
		const h = harness()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: {
					[EPIC]: {
						events: [{ id: '$a', mentions: ['@cc.proj.w.9999:host', WORKER.userId] }]
					}
				}
			})
		)
		await started(h)
		await h.relay.step()

		expect(h.routed).toHaveLength(1)
		expect(h.routed[0].to).toBe('sess-1')
	})

	it('wakes nobody when the event names nobody registered', async () => {
		const h = harness()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$a', body: 'thinking out loud' }] } }
			})
		)
		await started(h)
		await h.relay.step()

		expect(h.routed).toEqual([])
	})
})

describe('createMatrixRelay (the read cursor)', () => {
	async function started(): Promise<RelayHarness> {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()
		return h
	}

	it('advances so a later mention reports only what arrived since', async () => {
		const h = await started()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: {
					[EPIC]: {
						events: [
							{ id: '$1', body: 'one' },
							{ id: '$2', body: 'two' },
							{ id: '$3', body: 'three', mentions: [WORKER.userId] }
						]
					}
				}
			}),
			syncBody({
				nextBatch: 's-3',
				rooms: { [EPIC]: { events: [{ id: '$4', body: 'again', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.step()
		await h.relay.step()

		expect(h.routed[0].msg.relay?.unread).toBe(3)
		expect(h.routed[1].msg.relay?.unread).toBe(1)
	})

	it('reports the pre-delivery cursor as since while persisting the post-delivery one', async () => {
		const h = await started()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$1', mentions: [WORKER.userId] }] } }
			}),
			syncBody({
				nextBatch: 's-3',
				rooms: { [EPIC]: { events: [{ id: '$2', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.step()
		expect(h.routed[0].msg.relay?.since).toBe('s-1')
		expect(h.state.getCursor(WORKER.identity, EPIC)?.token).toBe('s-2')

		await h.relay.step()
		expect(h.routed[1].msg.relay?.since).toBe('s-2')
		expect(h.state.getCursor(WORKER.identity, EPIC)?.token).toBe('s-3')
	})

	it('persists the position only after the batch has been processed', async () => {
		const h = await started()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$1', mentions: [WORKER.userId] }] } }
			})
		)
		expect(h.state.getSyncToken(BOT)).toBe('s-1')

		await h.relay.step()

		// The wake was routed while the position still named the previous batch: persisting
		// first would let a crash mid-batch skip every event in it, permanently.
		expect(h.routed[0].tokenAtRoute).toBe('s-1')
		expect(h.state.getSyncToken(BOT)).toBe('s-2')
		expect(h.routed).toHaveLength(1)
	})

	it('wakes nothing a second time when a batch is replayed', async () => {
		const h = await started()
		const spec = {
			nextBatch: 's-2',
			rooms: { [EPIC]: { events: [{ id: '$1', mentions: [WORKER.userId] }] } }
		}
		h.queue.push(syncBody(spec), syncBody(spec))
		await h.relay.step()
		await h.relay.step()

		expect(h.routed).toHaveLength(1)
	})
})

describe('createMatrixRelay (a history read consumes what it returned)', () => {
	it('reports only what arrived after a read when the identity is next mentioned', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(
			syncBody({ nextBatch: 's-recon' }),
			syncBody({
				nextBatch: 's-2',
				rooms: {
					[EPIC]: {
						events: [
							{ id: '$1', body: 'one' },
							{ id: '$2', body: 'two' }
						]
					}
				}
			}),
			syncBody({
				nextBatch: 's-3',
				rooms: { [EPIC]: { events: [{ id: '$3', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.start()
		await h.relay.step()

		// The session read its room, which consumed the two messages waiting there.
		h.relay.markRead(WORKER.identity, EPIC, 's-page-end')
		await h.relay.step()

		expect(h.routed[0].msg.relay?.unread).toBe(1)
		expect(h.routed[0].msg.relay?.since).toBe('s-page-end')
	})

	it('never moves a cursor backwards on a stale read', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(
			syncBody({ nextBatch: 's-recon' }),
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$1', mentions: [WORKER.userId] }] } }
			}),
			syncBody({
				nextBatch: 's-3',
				rooms: { [EPIC]: { events: [{ id: '$2', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.start()
		await h.relay.step()
		h.now.value -= 1_000
		h.relay.markRead(WORKER.identity, EPIC, 's-stale')
		await h.relay.step()

		expect(h.routed[1].msg.relay?.unread).toBe(1)
	})
})

describe('createMatrixRelay (identity is never cached)', () => {
	it('routes to the session id an identity most recently registered with', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(
			syncBody({ nextBatch: 's-recon' }),
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$1', mentions: [WORKER.userId] }] } }
			}),
			syncBody({
				nextBatch: 's-3',
				rooms: { [EPIC]: { events: [{ id: '$2', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.start()
		await h.relay.step()
		// The session re-registers under a corrected id, exactly as a resumed launch does. A
		// relay that remembered the first id would queue the second wake under an id nobody
		// holds — reported as success, delivered to nobody.
		h.sessions.set(WORKER.identity, 'sess-2')
		await h.relay.step()

		expect(h.routed.map((r) => r.to)).toEqual(['sess-1', 'sess-2'])
	})

	it('wakes an identity that only appears after the loop started', async () => {
		const h = harness({ identities: [], sessions: {} })
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(
			syncBody({ nextBatch: 's-recon' }),
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$1', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.start()
		h.setIdentities([WORKER])
		h.sessions.set(WORKER.identity, 'sess-9')
		await h.relay.step()

		expect(h.routed.map((r) => r.to)).toEqual(['sess-9'])
	})
})

describe('createMatrixRelay (blind spots)', () => {
	it('survives a fetch that throws, routing nothing and staying alive', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()

		h.fail = 'throw'
		await expect(h.relay.step()).resolves.toBeUndefined()
		expect(h.routed).toEqual([])

		h.fail = undefined
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$1', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.step()
		expect(h.routed).toHaveLength(1)
	})

	it('survives a 401 and a 429 without routing anything', async () => {
		for (const status of [401, 429]) {
			const h = harness()
			h.state.setSyncToken('s-1', BOT)
			h.queue.push(syncBody({ nextBatch: 's-recon' }))
			await h.relay.start()

			h.fail = { status, body: '{"errcode":"M_LIMIT_EXCEEDED"}' }
			await expect(h.relay.step()).resolves.toBeUndefined()
			expect(h.routed).toEqual([])
			expect(h.state.getSyncToken(BOT)).toBe('s-1')
		}
	})

	it('never advances the position past a batch it could not read', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()

		h.fail = { status: 500 }
		await h.relay.step()

		expect(h.state.getSyncToken(BOT)).toBe('s-1')
	})
})

describe('createMatrixRelay (invites, reconciled on every start)', () => {
	function joinsIn(h: RelayHarness): string[] {
		return h.requests
			.map((r) => new URL(r))
			.filter((u) => u.pathname.includes('/join/'))
			.map((u) => decodeURIComponent(u.pathname.split('/join/')[1] ?? ''))
	}

	it('joins an invite that was already pending before a cold start, exactly once', async () => {
		const h = harness()
		h.queue.push(
			syncBody({
				nextBatch: 's-5',
				invites: { '!root:host': OPERATOR },
				rooms: { [EPIC]: { events: [{ id: '$old', mentions: [WORKER.userId] }] } }
			}),
			syncBody({ nextBatch: 's-6' })
		)

		await h.relay.start()
		await h.relay.step()

		expect(joinsIn(h)).toEqual(['!root:host'])
		expect(h.routed).toEqual([])
	})

	it('reconciles with no since and an empty-timeline filter', async () => {
		const h = harness()
		h.queue.push(syncBody({ nextBatch: 's-5' }))

		await h.relay.start()

		const reconciliation = syncRequests(h)[0]
		expect(reconciliation.searchParams.has('since')).toBe(false)
		expect(JSON.parse(reconciliation.searchParams.get('filter') ?? '{}')).toMatchObject({
			room: { timeline: { limit: 0 } }
		})
	})

	it('joins a failed invite after a restart that resumes from the persisted position', async () => {
		const path = tempStatePath()
		const first = harness({ statePath: path })
		first.state.setSyncToken('s-1', BOT)
		first.queue.push(syncBody({ nextBatch: 's-recon' }))
		await first.relay.start()
		// The invite arrives, its join fails, and the position is persisted past that batch.
		first.queue.push(syncBody({ nextBatch: 's-2', invites: { '!root:host': OPERATOR } }))
		const failing = first.relay.step()
		first.fail = { status: 500 }
		await failing
		first.fail = undefined
		first.state.flush()

		const second = harness({ statePath: path })
		second.queue.push(
			// The reconciliation snapshot still shows the invite pending; its next_batch is not
			// the stream's position, because the stream resumes from what was persisted.
			syncBody({ nextBatch: 's-999', invites: { '!root:host': OPERATOR } }),
			syncBody({ nextBatch: 's-3' })
		)
		await second.relay.start()
		await second.relay.step()

		expect(joinsIn(second)).toEqual(['!root:host'])
		expect(streamRequests(second)[0].searchParams.get('since')).toBe('s-2')
	})

	it('reads a room it joined by invite through the same single stream', async () => {
		const h = harness()
		h.queue.push(
			syncBody({ nextBatch: 's-5', invites: { '!root:host': OPERATOR } }),
			syncBody({
				nextBatch: 's-6',
				rooms: { '!root:host': { events: [{ id: '$a', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.start()
		const before = streamRequests(h).length
		await h.relay.step()

		expect(streamRequests(h).length).toBe(before + 1)
		expect(h.routed).toHaveLength(1)
		expect(h.routed[0].msg.relay?.room).toBe('!root:host')
	})

	it('wakes nothing for a mention in a room whose invite it declined', async () => {
		const h = harness()
		h.queue.push(
			syncBody({ nextBatch: 's-5', invites: { '!bad:host': '@mallory:host' } }),
			syncBody({
				nextBatch: 's-6',
				rooms: { '!bad:host': { events: [{ id: '$a', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.start()
		await h.relay.step()

		expect(joinsIn(h)).toEqual([])
		expect(h.routed).toEqual([])
	})
})

describe('createMatrixRelay (catch-up on register)', () => {
	async function offline(opts: HarnessOptions = {}): Promise<RelayHarness> {
		const h = harness({ sessions: {}, ...opts })
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()
		return h
	}

	it('delivers one wake for a mention missed while the identity had no session', async () => {
		const h = await offline()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: {
					[EPIC]: { events: [{ id: '$a', body: 'where are you', mentions: [WORKER.userId] }] }
				}
			})
		)
		await h.relay.step()
		expect(h.routed).toEqual([])

		h.sessions.set(WORKER.identity, 'sess-1')
		h.relay.onRegistered(WORKER.identity)

		expect(h.routed).toHaveLength(1)
		expect(h.routed[0].to).toBe('sess-1')
		expect(h.routed[0].msg.text).toContain('where are you')
	})

	it('counts every missed mention into one wake', async () => {
		const h = await offline()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: {
					[EPIC]: {
						events: [
							{ id: '$a', mentions: [WORKER.userId] },
							{ id: '$b', mentions: [WORKER.userId] },
							{ id: '$c', mentions: [WORKER.userId] }
						]
					}
				}
			})
		)
		await h.relay.step()

		h.sessions.set(WORKER.identity, 'sess-1')
		h.relay.onRegistered(WORKER.identity)

		expect(h.routed).toHaveLength(1)
		expect(h.routed[0].msg.relay?.unread).toBe(3)
	})

	it('obeys the cap and reports the pre-catch-up cursor', async () => {
		const h = await offline({ caps: { messages: 2, chars: 2000 } })
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: {
					[EPIC]: {
						events: [
							{ id: '$a', body: 'one' },
							{ id: '$b', body: 'two' },
							{ id: '$c', body: 'three', mentions: [WORKER.userId] }
						]
					}
				}
			})
		)
		await h.relay.step()

		h.sessions.set(WORKER.identity, 'sess-1')
		h.relay.onRegistered(WORKER.identity)

		expect(h.routed[0].msg.relay).toMatchObject({ unread: 2, omitted: 1, since: 's-1' })
	})

	it('wakes nothing for unread chatter that mentions nobody', async () => {
		const h = await offline()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$a', body: 'thinking out loud' }] } }
			})
		)
		await h.relay.step()

		h.sessions.set(WORKER.identity, 'sess-1')
		h.relay.onRegistered(WORKER.identity)

		expect(h.routed).toEqual([])
	})

	it('wakes nothing when there is nothing unread', async () => {
		const h = await offline()
		h.sessions.set(WORKER.identity, 'sess-1')
		h.relay.onRegistered(WORKER.identity)

		expect(h.routed).toEqual([])
	})

	it('does not repeat the catch-up on a second register', async () => {
		const h = await offline()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$a', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.step()

		h.sessions.set(WORKER.identity, 'sess-1')
		h.relay.onRegistered(WORKER.identity)
		h.relay.onRegistered(WORKER.identity)

		expect(h.routed).toHaveLength(1)
	})

	it('delivers one wake per room to an identity that missed mentions in two', async () => {
		const h = await offline()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: {
					[EPIC]: { events: [{ id: '$a', body: 'epic one', mentions: [WORKER.userId] }] },
					[LOBBY]: { events: [{ id: '$b', body: 'lobby one', mentions: [WORKER.userId] }] }
				}
			})
		)
		await h.relay.step()

		h.sessions.set(WORKER.identity, 'sess-1')
		h.relay.onRegistered(WORKER.identity)

		expect(h.routed).toHaveLength(2)
		expect(h.routed.map((r) => r.msg.relay?.room).sort()).toEqual([EPIC, LOBBY])
	})

	it('wakes nothing for an identity that is still not live', async () => {
		const h = await offline()
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$a', mentions: [WORKER.userId] }] } }
			})
		)
		await h.relay.step()

		h.relay.onRegistered(WORKER.identity)

		expect(h.routed).toEqual([])
	})

	it('never throws across its boundary for an identity it does not know', () => {
		const h = harness()
		expect(() => h.relay.onRegistered('nobody/at-all')).not.toThrow()
	})

	it('wakes on a missed room-wide mention only for a member of that room', async () => {
		const stranger: RelayIdentity = {
			identity: 'proj/other',
			userId: '@cc.proj.s.other:host',
			name: 'other',
			lobbyRoomId: LOBBY
		}
		const h = await offline({ identities: [WORKER, stranger] })
		h.queue.push(
			syncBody({
				nextBatch: 's-2',
				rooms: { [EPIC]: { events: [{ id: '$a', mentionsRoom: true }] } }
			})
		)
		await h.relay.step()

		h.sessions.set(WORKER.identity, 'sess-1')
		h.sessions.set(stranger.identity, 'sess-2')
		h.relay.onRegistered(WORKER.identity)
		h.relay.onRegistered(stranger.identity)

		expect(h.routed.map((r) => r.to)).toEqual(['sess-1'])
	})
})

describe('resolveReplyTarget', () => {
	const mention = { roomId: '!thread-room:host', threadRootEventId: '$root', at: 10 }

	it("answers in the room and thread of the person's most recent mention", () => {
		expect(
			resolveReplyTarget({ mention, identity: WORKER, isMember: (room) => room === mention.roomId })
		).toEqual({ roomId: '!thread-room:host', threadRootEventId: '$root' })
	})

	it("falls back to the caller's epic room on the main timeline with no prior mention", () => {
		expect(
			resolveReplyTarget({ mention: undefined, identity: WORKER, isMember: () => true })
		).toEqual({ roomId: EPIC })
	})

	it('falls back to the lobby for a caller with no epic', () => {
		const lobbyOnly: RelayIdentity = {
			identity: 'proj/notes',
			userId: '@cc.proj.s.notes:host',
			lobbyRoomId: LOBBY
		}
		expect(
			resolveReplyTarget({ mention: undefined, identity: lobbyOnly, isMember: () => true })
		).toEqual({ roomId: LOBBY })
	})

	it('falls back to its own room when the remembered one is no longer its own', () => {
		expect(resolveReplyTarget({ mention, identity: WORKER, isMember: () => false })).toEqual({
			roomId: EPIC
		})
	})

	it('answers nothing for an identity with no room at all', () => {
		const roomless: RelayIdentity = { identity: 'proj/none', userId: '@cc.proj.s.none:host' }
		expect(
			resolveReplyTarget({ mention: undefined, identity: roomless, isMember: () => true })
		).toBeUndefined()
	})
})

describe('createMatrixRelay (answering a person)', () => {
	function postsIn(h: RelayHarness): { room: string; asUser: string | null; body: unknown }[] {
		return h.requests
			.map((r) => new URL(r))
			.filter((u) => u.pathname.includes('/send/m.room.message/'))
			.map((u) => ({
				room: decodeURIComponent(u.pathname.split('/rooms/')[1]?.split('/')[0] ?? ''),
				asUser: u.searchParams.get('user_id'),
				body: undefined
			}))
	}

	async function mentioned(h: RelayHarness, spec: BatchSpec): Promise<void> {
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }), syncBody(spec))
		await h.relay.start()
		await h.relay.step()
	}

	it('posts into the room and thread the person used, as the session itself', async () => {
		const h = harness()
		await mentioned(h, {
			nextBatch: 's-2',
			rooms: {
				[EPIC]: { events: [{ id: '$a', mentions: [WORKER.userId], thread: '$root' }] }
			}
		})

		const result = await h.relay.replyToHuman(WORKER.identity, { to: OPERATOR, text: 'on it' })

		expect(result).toMatchObject({ ok: true, room: EPIC })
		if (!result.ok) return
		expect(result.thread).toBe(h.routed[0].msg.relay?.thread)
		expect(postsIn(h)).toEqual([{ room: EPIC, asUser: WORKER.userId, body: undefined }])
	})

	it("falls back to the caller's own room with no prior mention", async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()

		const result = await h.relay.replyToHuman(WORKER.identity, { to: OPERATOR, text: 'unprompted' })

		expect(result).toEqual({ ok: true, room: EPIC })
	})

	it('answers in the later of two rooms the person used', async () => {
		const h = harness()
		await mentioned(h, {
			nextBatch: 's-2',
			rooms: {
				[EPIC]: { events: [{ id: '$a', mentions: [WORKER.userId] }] },
				[LOBBY]: { events: [{ id: '$b', mentions: [WORKER.userId] }] }
			}
		})

		expect(
			await h.relay.replyToHuman(WORKER.identity, { to: OPERATOR, text: 'on it' })
		).toMatchObject({ ok: true, room: LOBBY })
	})

	it('answers not_found for an identity it has never heard of', async () => {
		const h = harness()
		await expect(
			h.relay.replyToHuman('nobody/at-all', { to: OPERATOR, text: 'hello' })
		).resolves.toEqual({ ok: false, reason: 'not_found' })
	})

	it('answers unavailable rather than throwing when the post fails', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()
		h.fail = { status: 500 }

		await expect(
			h.relay.replyToHuman(WORKER.identity, { to: OPERATOR, text: 'on it' })
		).resolves.toEqual({ ok: false, reason: 'unavailable' })
	})
})

describe('createMatrixRelay (the loop)', () => {
	it('keeps asking until it is stopped, and a failing iteration reaches no fatal handler', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()
		const before = streamRequests(h).length

		h.fail = 'throw'
		h.relay.run()
		// One iteration is enough: an escaped rejection would fail this test outright, which is
		// what the process's own backstop would do to the broker.
		await new Promise((resolve) => setTimeout(resolve, 10))
		h.relay.stop()

		expect(streamRequests(h).length).toBeGreaterThan(before)
		expect(h.routed).toEqual([])
	})

	it('stops asking once stopped', async () => {
		const h = harness()
		h.state.setSyncToken('s-1', BOT)
		h.queue.push(syncBody({ nextBatch: 's-recon' }))
		await h.relay.start()
		h.relay.stop()

		await h.relay.step()

		expect(streamRequests(h)).toEqual([])
	})
})
