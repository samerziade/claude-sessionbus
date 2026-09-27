import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Durable bookkeeping for the bridge: the sync position, a read cursor per identity and the
 * thread handles a later change mints. A seam, like `Transport` in `bus`: one interface, one
 * file-backed implementation today, so moving to another store stays a decision rather than a
 * drift.
 *
 * Reads are served from memory, so a value is visible the instant it is set. Writes are
 * debounced and land as one whole document written to a temporary name and renamed into
 * place, so a reader never observes a partial write. A document that is missing, unreadable or
 * malformed is treated exactly as an absent one and is replaced by the next flush — the same
 * tolerance the session registry already applies, for the same reason.
 */
/**
 * How far one identity has read in one room. The token is a homeserver stream position, opaque
 * here and everywhere above: it is round-tripped, never parsed. `at` is when the position was
 * reached, and exists because monotonicity is otherwise undecidable — two opaque tokens cannot
 * be compared, so a replayed or out-of-order advance would silently move the cursor backwards
 * and re-deliver everything between the two.
 */
export interface ReadCursor {
	token: string
	at: number
}

export interface BridgeState {
	/**
	 * The persisted sync position, but only when it was recorded under `botUser`. A position is
	 * scoped to the stream that produced it, so one recorded as another bot is unusable rather
	 * than merely stale — the safe answer is to cold-start, not to resume someone else's stream.
	 */
	getSyncToken(botUser: string): string | undefined
	setSyncToken(token: string, botUser: string): void
	getCursor(identity: string, room: string): ReadCursor | undefined
	/** Advance is monotonic: an older position applied after a newer one is a no-op. */
	setCursor(identity: string, room: string, cursor: ReadCursor): void
	resolveThread(handle: string): string | undefined
	rememberThread(handle: string, rootEventId: string): void
	/**
	 * Persist now, if anything changed since the last write. Explicit because a deliberate
	 * shutdown between two debounced writes would otherwise lose everything set since the last
	 * one — and deliberate shutdown is this daemon's common exit.
	 */
	flush(): void
}

export interface BridgeStateOptions {
	path: string
	now?: () => number
	debounceMs?: number
}

/** The sync position together with the bot identity whose stream produced it. */
interface SyncPosition {
	token: string
	botUser: string
}

/** The on-disk document. Every field is optional on read: a partial document is still usable. */
interface StateDocument {
	version: number
	updatedAt: number
	sync?: SyncPosition
	/** identity → room → cursor. Nested rather than keyed on a joined string, so a room id or a
	 * user id containing the separator cannot collide with another pair. */
	cursors: Record<string, Record<string, ReadCursor>>
	threads: Record<string, string>
}

const DOCUMENT_VERSION = 1
const DEFAULT_DEBOUNCE_MS = 500

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** Keep the string-valued entries of a record; drop anything else rather than failing the load. */
function readStringMap(x: unknown): Record<string, string> {
	const out: Record<string, string> = {}
	if (!isPlainObject(x)) return out
	for (const [k, v] of Object.entries(x)) {
		if (typeof v === 'string') out[k] = v
	}
	return out
}

function readCursor(x: unknown): ReadCursor | undefined {
	if (!isPlainObject(x)) return undefined
	const { token, at } = x
	if (typeof token !== 'string' || typeof at !== 'number') return undefined
	return { token, at }
}

/** Keep the rows that parse; drop the rest rather than failing the whole load. */
function readCursors(x: unknown): Record<string, Record<string, ReadCursor>> {
	const out: Record<string, Record<string, ReadCursor>> = {}
	if (!isPlainObject(x)) return out
	for (const [identity, rooms] of Object.entries(x)) {
		if (!isPlainObject(rooms)) continue
		const byRoom: Record<string, ReadCursor> = {}
		for (const [room, cursor] of Object.entries(rooms)) {
			const parsed = readCursor(cursor)
			if (parsed !== undefined) byRoom[room] = parsed
		}
		out[identity] = byRoom
	}
	return out
}

function readSync(x: unknown): SyncPosition | undefined {
	if (!isPlainObject(x)) return undefined
	const { token, botUser } = x
	if (typeof token !== 'string' || typeof botUser !== 'string') return undefined
	return { token, botUser }
}

function loadDocument(path: string, now: () => number): StateDocument {
	const empty: StateDocument = {
		version: DOCUMENT_VERSION,
		updatedAt: now(),
		cursors: {},
		threads: {}
	}
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch {
		return empty // absent or unreadable: the same thing as far as a reader is concerned
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return empty // truncated by a crash mid-write, or edited by hand into nonsense
	}
	if (!isPlainObject(parsed)) return empty
	return {
		version: DOCUMENT_VERSION,
		updatedAt: now(),
		sync: readSync(parsed.sync),
		cursors: readCursors(parsed.cursors),
		threads: readStringMap(parsed.threads)
	}
}

export function createBridgeState(opts: BridgeStateOptions): BridgeState {
	const now = opts.now ?? Date.now
	const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
	const doc = loadDocument(opts.path, now)
	let dirty = false
	let timer: ReturnType<typeof setTimeout> | undefined

	function persist(): void {
		doc.updatedAt = now()
		const tmp = `${opts.path}.tmp`
		mkdirSync(dirname(opts.path), { recursive: true })
		writeFileSync(tmp, `${JSON.stringify(doc)}\n`)
		renameSync(tmp, opts.path)
		dirty = false
	}

	function touch(): void {
		dirty = true
		if (timer !== undefined) return
		timer = setTimeout(() => {
			timer = undefined
			try {
				persist()
			} catch {
				// A failed write is not worth ending the process for: every value here is
				// reconstructible, and the next flush tries again.
			}
		}, debounceMs)
		timer.unref?.()
	}

	function flush(): void {
		if (timer !== undefined) {
			clearTimeout(timer)
			timer = undefined
		}
		if (!dirty) return
		persist()
	}

	return {
		getSyncToken: (botUser) => (doc.sync?.botUser === botUser ? doc.sync.token : undefined),
		setSyncToken: (token, botUser) => {
			doc.sync = { token, botUser }
			touch()
		},
		getCursor: (identity, room) => doc.cursors[identity]?.[room],
		setCursor: (identity, room, cursor) => {
			const rooms = doc.cursors[identity] ?? {}
			const held = rooms[room]
			// Monotonic: an advance that would move the cursor *backwards* is a no-op, so a
			// replayed batch cannot re-deliver everything between the two positions. A tie is
			// not backwards and the later write wins — two advances can land in the same
			// millisecond, and rejecting the second would strand a cursor mid-batch.
			if (held !== undefined && held.at > cursor.at) return
			rooms[room] = cursor
			doc.cursors[identity] = rooms
			touch()
		},
		resolveThread: (handle) => doc.threads[handle],
		rememberThread: (handle, rootEventId) => {
			doc.threads[handle] = rootEventId
			touch()
		},
		flush
	}
}
