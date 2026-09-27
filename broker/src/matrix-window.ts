import { localpartOf } from './matrix-names.ts'

/**
 * The unread window a wake carries, and how it reads.
 *
 * Both halves are pure. Window selection, the two caps, the waking-event exemption and the
 * transcript's shape are where the fiddly decisions live — truncation, off-thread prefixes,
 * multi-line bodies, a zero-padded clock — and keeping them out of the I/O module is what makes
 * them cheap to test exhaustively.
 *
 * The window is inlined into the wake rather than left to be pulled, because a pull-only wake
 * has a silent failure mode with no detector: the model answers from the mention line alone and
 * nothing anywhere notices the missing context. The cap bounds what inlining costs, keeps the
 * newest — the mention and its lead-up are what is being asked about — and never drops the
 * waking event itself, since a wake whose own trigger was trimmed away is useless.
 *
 * A thread is named by its handle and never by its root event id: an event id is a meaningful
 * fraction of the character cap, and a handle is the value `send_message`'s `thread` argument
 * accepts, so what the model reads is what it can pass back.
 */

export interface WindowMessage {
	eventId: string
	/** Full Matrix user id of the sender. */
	sender: string
	/** Display name, when the room has told us one. */
	senderDisplayName?: string
	body: string
	/** Origin-server timestamp. */
	at: number
	/** The handle of the thread this belongs to; absent for the room's main timeline. */
	threadHandle?: string
}

export interface WindowCaps {
	messages: number
	chars: number
}

export interface BuildWindowInput {
	/** The backlog, oldest first. The last entry is the waking event. */
	messages: WindowMessage[]
	/** The wake's own thread, so lines from it are not prefixed with a handle. */
	wakeThread?: string
	caps: WindowCaps
	/**
	 * Minutes to add to UTC when rendering a clock time. Injected rather than read from the
	 * host, so `[14:02]` is the same in every environment a test runs in.
	 */
	tzOffsetMinutes?: number
}

export interface WindowResult {
	/** The rendered transcript — what becomes the notification content. */
	content: string
	/** How many messages the window delivered. */
	unread: number
	/** How many the cap dropped. `unread + omitted` is the whole backlog. */
	omitted: number
}

const MS_PER_MINUTE = 60_000

function pad2(n: number): string {
	return String(n).padStart(2, '0')
}

function clock(at: number, tzOffsetMinutes: number): string {
	const shifted = new Date(at + tzOffsetMinutes * MS_PER_MINUTE)
	return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`
}

function senderOf(message: WindowMessage): string {
	const name = message.senderDisplayName
	return name !== undefined && name.length > 0 ? name : localpartOf(message.sender)
}

/**
 * `[HH:MM] <sender>: <text>`, oldest first, joined by a single newline with none trailing. A
 * message from a thread other than the wake's own carries that thread's handle after the time,
 * so a mixed window is unambiguous. A multi-line body is carried verbatim: only its first line
 * is prefixed.
 */
export function renderTranscript(
	messages: WindowMessage[],
	wakeThread?: string,
	tzOffsetMinutes = 0
): string {
	return messages
		.map((message) => {
			const handle = message.threadHandle
			const prefix = handle !== undefined && handle !== wakeThread ? `(${handle}) ` : ''
			return `[${clock(message.at, tzOffsetMinutes)}] ${prefix}${senderOf(message)}: ${message.body}`
		})
		.join('\n')
}

export function buildWindow(input: BuildWindowInput): WindowResult {
	const total = input.messages.length
	if (total === 0) return { content: '', unread: 0, omitted: 0 }

	// The message cap first, keeping the newest.
	let kept = input.messages.slice(Math.max(0, total - Math.max(1, input.caps.messages)))
	let content = renderTranscript(kept, input.wakeThread, input.tzOffsetMinutes)
	// Then the character cap, dropping from the head — never below the waking event, which is
	// exempt: a wake that trimmed away its own trigger would say nothing worth waking for.
	while (content.length > input.caps.chars && kept.length > 1) {
		kept = kept.slice(1)
		content = renderTranscript(kept, input.wakeThread, input.tzOffsetMinutes)
	}
	return { content, unread: kept.length, omitted: total - kept.length }
}
