import type { MatrixClient } from './matrix-client.ts'
import type { MirrorPost, PostOutcome } from './matrix-mirror.ts'

export interface PosterDeps {
	client: MatrixClient
	log?: (msg: string) => void
}

/**
 * Adapt the homeserver client to the mirror's `post` seam.
 *
 * The mirror owns queueing, ordering and backoff and needs only "did it land, and did the server
 * ask us to wait"; the client speaks typed outcomes. Keeping the translation here is what lets the
 * mirror be tested without a client and the client without a mirror.
 *
 * A post is always made as the sending identity. The bridge's own user takes part in no
 * conversation, so a post attributed to it would be a message from the wrong author — and the
 * relay would then drop it as a namespace echo, making it invisible rather than merely misnamed.
 */
export function createPoster(deps: PosterDeps): (post: MirrorPost) => Promise<PostOutcome> {
	const log = deps.log ?? (() => {})
	return async (post) => {
		const sent = await deps.client.sendMessage(
			{
				roomId: post.roomId,
				text: post.text,
				txnId: post.txnId,
				threadRootEventId: post.threadRootEventId,
				mentions: post.mentions
			},
			post.asUser
		)
		if (sent.ok) return { ok: true, eventId: sent.value.eventId }
		// The text stays out of the log: a failed mirror is an operational event, and the room,
		// the author and the reason are what an operator needs to act on it.
		log(`mirror: post to ${post.roomId} as ${post.asUser} failed (${sent.message})`)
		return { ok: false, retryAfterMs: sent.retryAfterMs }
	}
}
