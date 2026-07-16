import type { ChannelMessage } from '../../bus/src/message.ts'

export const PROTOCOL_VERSION = 1

export interface RegisterFrame {
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

export type Frame =
	| RegisterFrame
	| SendFrame
	| DeliverFrame
	| WelcomeFrame
	| StatsRequestFrame
	| StatsReplyFrame

const FRAME_TYPES = new Set(['register', 'send', 'deliver', 'welcome', 'stats', 'stats_reply'])

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
