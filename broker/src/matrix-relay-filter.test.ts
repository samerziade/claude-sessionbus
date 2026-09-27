import { describe, expect, it } from 'vitest'
import {
	createInboundFilter,
	type InboundEvent,
	type InboundFilterDeps
} from './matrix-relay-filter.ts'

const OPERATOR = '@samer:host'
const WORKER = '@cc.proj.w.123:host'
const PM = '@cc.proj.pm.42:host'

function event(over: Partial<InboundEvent> = {}): InboundEvent {
	return {
		eventId: `$e-${Math.random().toString(36).slice(2)}`,
		roomId: '!room:host',
		sender: OPERATOR,
		type: 'm.room.message',
		msgtype: 'm.text',
		body: 'ping',
		at: 1_700_000_000_000,
		mentionedUserIds: [WORKER],
		mentionsRoom: false,
		...over
	}
}

function filterWith(over: Partial<InboundFilterDeps> = {}) {
	return createInboundFilter({
		namespacePrefix: 'cc',
		isRegistered: (userId) => userId === WORKER || userId === PM,
		registeredMembers: () => [WORKER, PM],
		...over
	})
}

describe('createInboundFilter (happy path)', () => {
	it('accepts a plain text event from outside the namespace naming a registered identity', () => {
		const decide = filterWith()
		expect(decide(event())).toEqual({ kind: 'wake', targets: [WORKER] })
	})

	it('wakes every registered member but the sender on a room-wide mention', () => {
		const decide = filterWith({
			registeredMembers: () => [WORKER, PM]
		})
		const decision = decide(event({ mentionedUserIds: [], mentionsRoom: true }))

		expect(decision).toEqual({ kind: 'wake', targets: [WORKER, PM] })
	})
})

describe('createInboundFilter (negative)', () => {
	it('rejects an event whose sender is inside the namespace', () => {
		const decide = filterWith()
		expect(decide(event({ sender: PM }))).toEqual({ kind: 'history' })
	})

	it('rejects an event that is not a room message', () => {
		const decide = filterWith()
		expect(decide(event({ type: 'm.reaction', msgtype: undefined }))).toEqual({ kind: 'ignore' })
	})

	it('rejects a non-message event even when its content looks like a text message', () => {
		// The type is checked in its own right: an encrypted event or a state event can carry a
		// `body` and an `m.text` msgtype, and neither is a message anyone said.
		const decide = filterWith()
		expect(decide(event({ type: 'm.room.encrypted' }))).toEqual({ kind: 'ignore' })
	})

	it('rejects a room message that is not plain text', () => {
		const decide = filterWith()
		expect(decide(event({ msgtype: 'm.image' }))).toEqual({ kind: 'ignore' })
	})

	it('rejects a message with no body', () => {
		const decide = filterWith()
		expect(decide(event({ body: undefined }))).toEqual({ kind: 'ignore' })
	})

	it('rejects an event that would wake the identity that sent it', () => {
		// A registered identity whose user id falls outside the configured prefix — the only
		// shape that reaches this rule, and exactly what a misconfigured `namespacePrefix`
		// produces. Under a correct configuration rule 1 has already discarded it.
		const outsider = '@other.w.9:host'
		const decide = filterWith({
			isRegistered: (userId) => userId === outsider,
			registeredMembers: () => [outsider]
		})

		expect(decide(event({ sender: outsider, mentionedUserIds: [outsider] }))).toEqual({
			kind: 'ignore'
		})
	})

	it('keeps the other targets when an event names its own sender as well', () => {
		// A self-mention silences the sender and nobody else.
		const outsider = '@other.w.9:host'
		const decide = filterWith({
			isRegistered: (userId) => userId === outsider || userId === WORKER,
			registeredMembers: () => [outsider, WORKER]
		})

		expect(decide(event({ sender: outsider, mentionedUserIds: [outsider, WORKER] }))).toEqual({
			kind: 'wake',
			targets: [WORKER]
		})
	})
})

describe('createInboundFilter (edge cases)', () => {
	it('accepts an event id once and rejects every later sighting of it', () => {
		const decide = filterWith()
		const e = event()

		expect(decide(e)).toEqual({ kind: 'wake', targets: [WORKER] })
		expect(decide(e)).toEqual({ kind: 'ignore' })
		expect(decide(e)).toEqual({ kind: 'ignore' })
	})

	it('records an event as history when it names nobody registered', () => {
		const decide = filterWith()
		expect(decide(event({ mentionedUserIds: [] }))).toEqual({ kind: 'history' })
	})

	it('records an event as history when it names only unregistered namespace users', () => {
		const decide = filterWith()
		expect(decide(event({ mentionedUserIds: ['@cc.proj.w.999:host'] }))).toEqual({
			kind: 'history'
		})
	})

	it('resolves only the registered name when one registered and one unknown are named', () => {
		const decide = filterWith()
		const decision = decide(event({ mentionedUserIds: ['@cc.proj.w.999:host', PM] }))

		expect(decision).toEqual({ kind: 'wake', targets: [PM] })
	})

	it('names each identity once when an event mentions it twice', () => {
		const decide = filterWith()
		expect(decide(event({ mentionedUserIds: [WORKER, WORKER] }))).toEqual({
			kind: 'wake',
			targets: [WORKER]
		})
	})

	it('does not double up a room-wide mention with an explicit one', () => {
		const decide = filterWith({ registeredMembers: () => [WORKER, PM] })
		const decision = decide(event({ mentionedUserIds: [WORKER], mentionsRoom: true }))

		expect(decision).toEqual({ kind: 'wake', targets: [WORKER, PM] })
	})

	it('treats a bare prefix match as outside the namespace', () => {
		// `@ccx.…` starts with the prefix as a string but is not inside the `cc.` namespace.
		const decide = filterWith()
		expect(decide(event({ sender: '@ccx.proj.w.1:host' }))).toEqual({
			kind: 'wake',
			targets: [WORKER]
		})
	})
})

describe('createInboundFilter (blind spots)', () => {
	it('evicts the oldest id first and still recognises the newest as seen', () => {
		const decide = filterWith({ dedupeMax: 3 })
		const ids = ['$a', '$b', '$c', '$d']
		for (const eventId of ids)
			expect(decide(event({ eventId }))).toEqual({
				kind: 'wake',
				targets: [WORKER]
			})

		// `$a` was evicted, so it is no longer recognised; `$d` is the newest and still is.
		expect(decide(event({ eventId: '$a' }))).toEqual({ kind: 'wake', targets: [WORKER] })
		expect(decide(event({ eventId: '$d' }))).toEqual({ kind: 'ignore' })
	})

	it('remembers nothing about an event it rejected before the dedupe step', () => {
		const decide = filterWith()
		// A namespace sender is dropped ahead of dedupe, so the id stays unclaimed: were it
		// recorded, the same id arriving later from a human would be swallowed as a duplicate.
		expect(decide(event({ eventId: '$shared', sender: PM }))).toEqual({ kind: 'history' })
		expect(decide(event({ eventId: '$shared' }))).toEqual({ kind: 'wake', targets: [WORKER] })
	})

	it('does not consume an id for an event it never woke anything for', () => {
		const decide = filterWith()
		const e = event({ eventId: '$chatter', mentionedUserIds: [] })

		expect(decide(e)).toEqual({ kind: 'history' })
		// Recorded as processed: the same event arriving twice is one piece of history, not two.
		expect(decide(e)).toEqual({ kind: 'ignore' })
	})

	it('re-reads the registered set on every call rather than caching it', () => {
		let registered = new Set<string>()
		const decide = filterWith({
			isRegistered: (userId) => registered.has(userId),
			registeredMembers: () => [...registered]
		})

		expect(decide(event({ eventId: '$1' }))).toEqual({ kind: 'history' })
		registered = new Set([WORKER])
		expect(decide(event({ eventId: '$2' }))).toEqual({ kind: 'wake', targets: [WORKER] })
	})
})
