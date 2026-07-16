import { randomBytes } from 'node:crypto'

export interface MessageFrom {
	sessionId: string
	name: string
	epic?: string
	role: 'pm' | 'worker' | 'none'
}

export interface MessageTo {
	kind: 'session' | 'epic'
	value: string
}

export interface ChannelMessage {
	id: string
	from: MessageFrom
	to: MessageTo
	text: string
	createdAt: number
}

/** Sortable, dependency-free id: base36(timestamp) + '-' + random hex. */
export function newMessageId(now: number, rand: string = randomBytes(4).toString('hex')): string {
	return `${now.toString(36)}-${rand}`
}

/** First six hex chars of a session UUID, hyphens removed — used as from_id. */
export function shortId(sessionId: string): string {
	return sessionId.replace(/-/g, '').slice(0, 6)
}

/**
 * Build the <channel> tag attributes. Keys must be identifier-safe
 * (letters/digits/underscore); the channel contract silently drops others.
 */
export function toChannelMeta(msg: ChannelMessage): Record<string, string> {
	const meta: Record<string, string> = {
		from: msg.from.name,
		from_id: shortId(msg.from.sessionId),
		role: msg.from.role,
		msg_id: msg.id
	}
	if (msg.from.epic) meta.epic = msg.from.epic
	return meta
}
