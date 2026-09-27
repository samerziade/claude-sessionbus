import type {
	HistoryQuery,
	HistoryResult,
	MatrixReplyRequest,
	MatrixReplyResult
} from '../../bus/src/mailbox.ts'
import type { ChannelMessage } from '../../bus/src/message.ts'

export const PROTOCOL_VERSION = 1

/**
 * What a session announces about itself when it registers, for grouping. Every field is
 * optional and the protocol version does not move for them: a `bus` that predates them binds
 * exactly as before, where a version bump would make it unreachable rather than merely
 * unprovisioned. One home for them, so the wire contract and the broker cannot drift.
 */
export interface RegisterMeta {
	project?: string
	/**
	 * The project as a person recognizes it — `<owner>/<repo>` — when the project was derived
	 * from a remote carrying both. Only the session knows it: `project` is a slug, and which of
	 * its dashes was the owner's cannot be recovered from it. Absent means the project's own
	 * slug is the only name there is.
	 */
	projectName?: string
	title?: string
}

export interface RegisterFrame extends RegisterMeta {
	type: 'register'
	sessionId: string
	protocolVersion: number
}

export interface SendFrame {
	type: 'send'
	to: string
	msg: ChannelMessage
}

export interface DeliverFrame {
	type: 'deliver'
	msg: ChannelMessage
}

export interface WelcomeFrame {
	type: 'welcome'
	protocolVersion: number
}

export interface StatsRequestFrame {
	type: 'stats'
}

export interface StatsReplyFrame {
	type: 'stats_reply'
	connected: number
}

/**
 * Request/reply, unlike everything else here: a history read has an answer, so the pair carries
 * a correlation id. The payload types are imported from their home in `bus` rather than
 * restated, so the wire shape cannot drift from the shape the tool returns.
 */
export interface HistoryRequestFrame {
	type: 'history'
	id: string
	query: HistoryQuery
}

export interface HistoryReplyFrame {
	type: 'history_reply'
	id: string
	result: HistoryResult
}

export interface MatrixReplyRequestFrame {
	type: 'matrix_reply'
	id: string
	request: MatrixReplyRequest
}

export interface MatrixReplyResultFrame {
	type: 'matrix_reply_result'
	id: string
	result: MatrixReplyResult
}

export type Frame =
	| RegisterFrame
	| SendFrame
	| DeliverFrame
	| WelcomeFrame
	| StatsRequestFrame
	| StatsReplyFrame
	| HistoryRequestFrame
	| HistoryReplyFrame
	| MatrixReplyRequestFrame
	| MatrixReplyResultFrame

const FRAME_TYPES = new Set([
	'register',
	'send',
	'deliver',
	'welcome',
	'stats',
	'stats_reply',
	'history',
	'history_reply',
	'matrix_reply',
	'matrix_reply_result'
])

function isFrame(v: unknown): v is Frame {
	if (typeof v !== 'object' || v === null) return false
	const t = (v as { type?: unknown }).type
	return typeof t === 'string' && FRAME_TYPES.has(t)
}

/** One JSON object per line, newline-terminated. */
export function encodeFrame(frame: Frame): string {
	return `${JSON.stringify(frame)}\n`
}

/**
 * Stateful streaming decoder: feed it socket chunks, get back complete frames.
 * Buffers a trailing partial line; skips a line that is not valid frame JSON.
 */
export function createFrameDecoder(): (chunk: string) => Frame[] {
	let buffer = ''
	return (chunk: string): Frame[] => {
		buffer += chunk
		const frames: Frame[] = []
		let idx = buffer.indexOf('\n')
		while (idx !== -1) {
			const line = buffer.slice(0, idx)
			buffer = buffer.slice(idx + 1)
			if (line.length > 0) {
				try {
					const parsed: unknown = JSON.parse(line)
					if (isFrame(parsed)) frames.push(parsed)
				} catch {
					// skip unparseable line
				}
			}
			idx = buffer.indexOf('\n')
		}
		return frames
	}
}
