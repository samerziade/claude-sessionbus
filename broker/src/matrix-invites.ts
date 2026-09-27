import type { MatrixClient, SyncBatch } from './matrix-client.ts'

/**
 * Who the bridge bot is willing to be invited by.
 *
 * The homeserver does not auto-accept invites and, with no push URL, tells the bridge nothing:
 * an invite to the bot — above all to the operator's root space, where the bot has to add child
 * spaces — stays pending until the bot joins it. The only component that ever sees one is the
 * bot's own sync stream.
 *
 * The rule is a security boundary rather than a convenience. The relay wakes sessions on a
 * mention in any room the bot belongs to, so joining a room grants that room's members the
 * power to start a turn in a Claude session. Accepting any local account's invite would hand
 * that power to every account on the homeserver, from a room that account controls; federation
 * being off does not help, because the exposure is local accounts.
 *
 * With no operator configured nothing is joined *and* nothing is declined: failing closed
 * without destroying the invite, so the operator's pending invites are still there once the
 * configuration is fixed.
 */

export type InviteDecision = 'accept' | 'decline' | 'ignore'

export interface InviteInput {
	/** Sender of the bot's own invite membership event. */
	inviter?: string
	/** The configured operator — the `owner` of the Matrix configuration. */
	operator?: string
}

export interface InviteHandlerDeps {
	client: Pick<MatrixClient, 'joinRoom' | 'leaveRoom'>
	/** The user every join and decline is issued as. */
	botUser: string
	operator?: string
	log?: (msg: string) => void
}

export interface InviteHandler {
	/**
	 * Handle one sync batch's invites, and retry anything a previous batch still owes a join.
	 * Resolves when every join and decline it issued has settled, and never rejects: an escaped
	 * rejection would reach the process-level backstop and turn a homeserver hiccup into a
	 * supervised restart.
	 */
	onBatch(batch: SyncBatch): Promise<void>
	/** Rooms still owed a join. Observability, not control. */
	pending(): string[]
	/**
	 * Whether this room's invite was declined. A declined room is one the bot is not in, so
	 * anything the homeserver still reports for it is not the bridge's to act on.
	 */
	isDeclined(roomId: string): boolean
}

/**
 * Compared by exact user id and nothing else. A display name is free text that any account can
 * set to the operator's, so consulting one would make the boundary decorative — which is why
 * this function is never even given a display name to compare.
 *
 * An invite whose inviter could not be read is `ignore`, not `decline`: it is not an invite
 * from someone else, it is an invite we could not attribute, and declining destroys it.
 */
export function decideInvite(input: InviteInput): InviteDecision {
	const operator = input.operator
	if (operator === undefined || operator.length === 0) return 'ignore'
	if (input.inviter === undefined) return 'ignore'
	return input.inviter === operator ? 'accept' : 'decline'
}

export function createInviteHandler(deps: InviteHandlerDeps): InviteHandler {
	const log = deps.log ?? (() => {})
	/** Joins in flight, shared so a replayed batch adopts the attempt rather than doubling it. */
	const joining = new Map<string, Promise<void>>()
	/** Rooms we have joined, so a replayed invite is not joined a second time. */
	const joined = new Set<string>()
	/** Rooms whose join failed and is owed a retry on a later iteration. */
	const owed = new Set<string>()
	/** Rooms already declined, so a replayed invite is not left twice. */
	const declined = new Set<string>()

	/** Idempotent in its own right: every caller relies on this rather than guarding itself. */
	function join(roomId: string): Promise<void> {
		const inFlight = joining.get(roomId)
		if (inFlight !== undefined) return inFlight
		const attempt = deps.client
			.joinRoom(roomId, deps.botUser)
			.then((result) => {
				if (result.ok) {
					joined.add(roomId)
					owed.delete(roomId)
					return
				}
				// Kept, never converted into a decline: a homeserver that could not join us is
				// not an inviter we refused, and declining would destroy an invite we want.
				owed.add(roomId)
				log(`invites: joining ${roomId} failed; will retry (${result.message})`)
			})
			.catch((err: unknown) => {
				owed.add(roomId)
				log(`invites: joining ${roomId} threw; will retry (${err})`)
			})
			.finally(() => {
				joining.delete(roomId)
			})
		joining.set(roomId, attempt)
		return attempt
	}

	function decline(roomId: string): Promise<void> {
		if (declined.has(roomId)) return Promise.resolve()
		declined.add(roomId)
		return deps.client
			.leaveRoom(roomId, deps.botUser)
			.then((result) => {
				if (!result.ok) log(`invites: declining ${roomId} failed (${result.message})`)
			})
			.catch((err: unknown) => {
				log(`invites: declining ${roomId} threw (${err})`)
			})
	}

	async function onBatch(batch: SyncBatch): Promise<void> {
		// A room we have left is a room whose invite is gone: stop retrying it, and forget that
		// we were ever in it, so a fresh invite is joined rather than assumed already handled.
		for (const roomId of batch.leftRooms) {
			owed.delete(roomId)
			joined.delete(roomId)
		}
		for (const roomId of batch.joinedRooms) joined.add(roomId)

		const pendingWork: Promise<void>[] = []
		for (const invite of batch.invites) {
			if (joined.has(invite.roomId)) continue
			const decision = decideInvite({ inviter: invite.inviter, operator: deps.operator })
			if (decision === 'accept') {
				// A room declined earlier and now invited by the operator is theirs to reinstate.
				declined.delete(invite.roomId)
				pendingWork.push(join(invite.roomId))
			} else if (decision === 'decline') pendingWork.push(decline(invite.roomId))
		}
		// The retry cannot wait for the invite to reappear: an incremental sync reports a
		// membership change once, and the position is persisted past that batch, so a failed
		// join would otherwise be lost until the operator invited us again.
		for (const roomId of [...owed]) pendingWork.push(join(roomId))
		await Promise.all(pendingWork)
	}

	return { onBatch, pending: () => [...owed], isDeclined: (roomId) => declined.has(roomId) }
}
