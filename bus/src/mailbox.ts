import {
	existsSync,
	type FSWatcher,
	watch as fsWatch,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { ChannelMessage, MessageOrigin } from './message.ts'

/**
 * What a session asks for when it reads a room's history. Every field is optional: the common
 * call is `read_history({})`, which answers for the caller's own room.
 */
export interface HistoryQuery {
	room?: string
	thread?: string
	/** An opaque cursor from a wake or a previous read. Round-tripped, never parsed. */
	since?: string
	limit?: number
	search?: string
}

/** One message as a history read reports it. */
export interface HistoryMessage {
	from: string
	/** The value that identifies the author: a full Matrix user id. */
	from_id: string
	origin: MessageOrigin
	text: string
	at: number
	/** The handle of the thread it belongs to, when it is in one. */
	thread?: string
}

/**
 * A discriminated union so a caller narrows on `ok` rather than casting. `unavailable` means
 * there is no bridge to ask — a complete, correct answer for a transport without one, and the
 * reason nothing here ever throws across the boundary.
 */
export type HistoryResult =
	| { ok: true; room: string; messages: HistoryMessage[]; more: boolean }
	| { ok: false; reason: 'unavailable' | 'not_found' }

/** A reply addressed to a person rather than to a session. */
export interface MatrixReplyRequest {
	/** A full Matrix user id outside the namespace. */
	to: string
	text: string
}

export type MatrixReplyResult =
	| { ok: true; room: string; thread?: string }
	| { ok: false; reason: 'unavailable' | 'not_found' }

export interface Transport {
	/** Write a message into the recipient's inbox (atomic). */
	send(recipientSessionId: string, msg: ChannelMessage): void
	/** One inbox scan: return newly-seen messages and archive their files. */
	poll(ownSessionId: string): ChannelMessage[]
	/** Poll continuously (interval + fs.watch); returns a stop function. */
	watch(ownSessionId: string, onMessage: (msg: ChannelMessage) => void): () => void
	/**
	 * Point an active `watch` at a different session id.
	 *
	 * Our own id is not settled when we subscribe: a `--resume` launch rewrites the registry
	 * moments after spawning us. Peers address us by the id our beacon advertises, so a
	 * subscription left on the startup id makes us silently unreachable. No-op before `watch`.
	 */
	rekey(ownSessionId: string): void
	/**
	 * Read a room's history. Request/reply against the broker, which is exactly what this seam
	 * abstracts — giving `handlers.ts` a second connection of its own would mean choosing the
	 * file/socket backend twice and keeping the two in step by hand.
	 */
	history(query: HistoryQuery): Promise<HistoryResult>
	/** Post to a person in Matrix. Nothing local is written and no session is woken. */
	replyToHuman(req: MatrixReplyRequest): Promise<MatrixReplyResult>
}

/** There is no bridge behind this transport, and saying so is a complete answer. */
const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

const POLL_MS = 1000

export function createFileMailbox(channelsHome: string): Transport {
	// Keyed by inbox *and* id: a fan-out writes one id into several inboxes, so remembering the
	// id alone would let the first inbox drained swallow every other recipient's copy.
	const delivered = new Set<string>() // per-instance dedup across polls

	function inboxDir(sessionId: string): string {
		return join(channelsHome, 'bus', sessionId)
	}

	function send(recipientSessionId: string, msg: ChannelMessage): void {
		const dir = inboxDir(recipientSessionId)
		mkdirSync(dir, { recursive: true })
		const tmp = join(dir, `.${msg.id}.tmp`)
		const final = join(dir, `${msg.id}.json`)
		writeFileSync(tmp, JSON.stringify(msg))
		renameSync(tmp, final) // atomic on same filesystem: readers never see partial
	}

	function poll(ownSessionId: string): ChannelMessage[] {
		const dir = inboxDir(ownSessionId)
		if (!existsSync(dir)) return []
		const consumed = join(dir, 'consumed')
		mkdirSync(consumed, { recursive: true })

		const files = readdirSync(dir)
			.filter((f) => f.endsWith('.json'))
			.sort() // id has a base36 time prefix, so name order ~= arrival order

		const out: ChannelMessage[] = []
		for (const file of files) {
			const path = join(dir, file)
			let msg: ChannelMessage
			try {
				msg = JSON.parse(readFileSync(path, 'utf8')) as ChannelMessage
			} catch {
				continue // partially written; a later poll will catch it
			}
			const seen = `${ownSessionId}\u0000${msg.id}`
			if (!delivered.has(seen)) {
				delivered.add(seen)
				out.push(msg)
			}
			try {
				renameSync(path, join(consumed, file))
			} catch {
				// if archival races with another mover, ignore
			}
		}
		return out
	}

	let watched: string | undefined // the id `watch` is currently draining, if any
	let watcher: FSWatcher | undefined
	let observeCurrent: (() => void) | undefined // re-points the watcher at `watched`
	let stopped = false

	function watch(ownSessionId: string, onMessage: (msg: ChannelMessage) => void): () => void {
		watched = ownSessionId

		const drain = () => {
			if (watched === undefined || stopped) return
			for (const m of poll(watched)) onMessage(m)
		}

		// fs.watch is bound to one directory, so re-point it whenever the id changes; the
		// interval below is the safety net either way.
		const observe = () => {
			watcher?.close()
			watcher = undefined
			if (watched === undefined) return
			const dir = inboxDir(watched)
			mkdirSync(dir, { recursive: true })
			try {
				watcher = fsWatch(dir, () => drain()) // low-latency nudge
			} catch {
				// fs.watch unsupported here; interval still covers us
			}
			drain() // pick up anything already queued (offline messages)
		}

		observeCurrent = observe
		observe()
		const interval = setInterval(drain, POLL_MS)

		return () => {
			stopped = true
			clearInterval(interval)
			watcher?.close()
			watcher = undefined
		}
	}

	function rekey(ownSessionId: string): void {
		if (watched === ownSessionId) return
		watched = ownSessionId
		// Re-point the watcher and sweep the corrected inbox: peers have been addressing our
		// beacon id all along, so messages may already be waiting there.
		if (!stopped) observeCurrent?.()
	}

	return {
		send,
		poll,
		watch,
		rekey,
		// No I/O at all: a flat-file mailbox has no bridge to ask, and inventing an empty
		// success would read as "the room is empty" rather than "there is no room".
		history: async () => UNAVAILABLE,
		replyToHuman: async () => UNAVAILABLE
	}
}
