import { describe, expect, it } from 'vitest'
import type { MatrixClient, MatrixResult, SendMessageRequest, SentEvent } from './matrix-client.ts'
import type { MirrorPost } from './matrix-mirror.ts'
import { createPoster } from './matrix-post.ts'

interface Sent {
	req: SendMessageRequest
	asUser: string
}

function clientReturning(result: MatrixResult<SentEvent>): { client: MatrixClient; sent: Sent[] } {
	const sent: Sent[] = []
	const client = {
		sendMessage: (req: SendMessageRequest, asUser: string) => {
			sent.push({ req, asUser })
			return Promise.resolve(result)
		}
	} as unknown as MatrixClient
	return { client, sent }
}

function post(overrides: Partial<MirrorPost> = {}): MirrorPost {
	return {
		roomId: '!epic:example',
		asUser: '@cc.demo.w.123:example',
		txnId: 'm9x1-4f2a',
		text: 'the beacon guard is in',
		mentions: { userIds: ['@cc.demo.pm.42:example'], room: false },
		...overrides
	}
}

describe('createPoster', () => {
	it('posts as the sending identity, never as the bridge', async () => {
		const { client, sent } = clientReturning({ ok: true, value: { eventId: '$abc' } })
		await createPoster({ client })(post())

		expect(sent).toHaveLength(1)
		expect(sent[0]?.asUser).toBe('@cc.demo.w.123:example')
	})

	it('carries the message id as the transaction id so a retry is the same event', async () => {
		const { client, sent } = clientReturning({ ok: true, value: { eventId: '$abc' } })
		await createPoster({ client })(post())

		expect(sent[0]?.req.txnId).toBe('m9x1-4f2a')
	})

	it('passes the room, text, mentions and thread through unchanged', async () => {
		const { client, sent } = clientReturning({ ok: true, value: {} })
		await createPoster({ client })(post({ threadRootEventId: '$root' }))

		expect(sent[0]?.req).toEqual({
			roomId: '!epic:example',
			text: 'the beacon guard is in',
			txnId: 'm9x1-4f2a',
			threadRootEventId: '$root',
			mentions: { userIds: ['@cc.demo.pm.42:example'], room: false }
		})
	})

	it('omits the thread root for a timeline post', async () => {
		const { client, sent } = clientReturning({ ok: true, value: {} })
		await createPoster({ client })(post())

		expect(sent[0]?.req.threadRootEventId).toBeUndefined()
	})

	it('reports the event id when the homeserver returns one', async () => {
		const { client } = clientReturning({ ok: true, value: { eventId: '$abc' } })

		expect(await createPoster({ client })(post())).toEqual({ ok: true, eventId: '$abc' })
	})

	it('succeeds without an event id, which the homeserver need not return', async () => {
		const { client } = clientReturning({ ok: true, value: {} })

		expect(await createPoster({ client })(post())).toEqual({ ok: true, eventId: undefined })
	})

	it('surfaces the server-asked wait so the mirror honours it over its own backoff', async () => {
		const { client } = clientReturning({
			ok: false,
			kind: 'rate_limited',
			status: 429,
			retryAfterMs: 4_000,
			message: 'slow down'
		})

		expect(await createPoster({ client })(post())).toEqual({ ok: false, retryAfterMs: 4_000 })
	})

	it('fails without a wait when the server asked for none, leaving the mirror to back off', async () => {
		const { client } = clientReturning({
			ok: false,
			kind: 'server',
			status: 502,
			message: 'bad gateway'
		})

		expect(await createPoster({ client })(post())).toEqual({ ok: false, retryAfterMs: undefined })
	})

	it('logs a failure with the room and reason, and never the message text', async () => {
		const lines: string[] = []
		const { client } = clientReturning({
			ok: false,
			kind: 'auth',
			status: 403,
			message: 'forbidden',
			errcode: 'M_FORBIDDEN'
		})
		await createPoster({ client, log: (m) => lines.push(m) })(post())

		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain('!epic:example')
		expect(lines[0]).toContain('forbidden')
		expect(lines[0]).not.toContain('the beacon guard is in')
	})

	it('says nothing on success', async () => {
		const lines: string[] = []
		const { client } = clientReturning({ ok: true, value: { eventId: '$abc' } })
		await createPoster({ client, log: (m) => lines.push(m) })(post())

		expect(lines).toEqual([])
	})
})
