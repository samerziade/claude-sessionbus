import { resolveTargets } from './address.ts'
import { type PeerIdentity, resolveIdentity, type SessionEntry } from './identity.ts'
import type { HistoryQuery, HistoryResult, MatrixReplyResult, Transport } from './mailbox.ts'
import {
	type ChannelMessage,
	isThreadHandle,
	type MessageFrom,
	type MessageTo,
	newMessageId,
	shortId,
	type ThreadSelector,
	toChannelMeta
} from './message.ts'
import { readBeacons, readSessionEntries } from './registry.ts'

export interface PeerListEntry {
	sessionId: string
	shortId: string
	name: string
	role: string
	epic?: string
	issue?: string
	status?: string
	cwd?: string
	lastSeen?: number
}

export type SendResult =
	| {
			ok: true
			kind: 'session' | 'epic'
			recipients: { sessionId: string; name: string }[]
			count: number
	  }
	/** Posted to a person in Matrix: nothing local was written and no session was woken. */
	| { ok: true; kind: 'matrix'; to: string; room: string; thread?: string }
	| { ok: false; reason: string; candidates?: { sessionId: string; name: string }[] }

/** The default appservice namespace prefix; a user inside it is a session, not a person. */
const DEFAULT_NAMESPACE_PREFIX = 'cc'

/** A fully qualified Matrix user id: `@localpart:domain`, with no whitespace in either half. */
const MATRIX_USER_RE = /^@([^:\s]+):([^:\s]+)$/

/**
 * Whether a `to` names a person in Matrix rather than a session. Decided *before* local
 * resolution runs: a namespace user is a session and is reached locally, and everything else
 * that parses as a Matrix id is somebody the bridge can post to.
 */
export function isMatrixAddress(to: string, namespacePrefix: string): boolean {
	const match = MATRIX_USER_RE.exec(to)
	if (match === null) return false
	return !match[1].startsWith(`${namespacePrefix}.`)
}

export interface HandlerDeps {
	/**
	 * Resolved per call, never cached: a session can be renamed at any point after we start, and
	 * a `--resume` launch rewrites the registry milliseconds after spawning us.
	 */
	self: () => PeerIdentity
	channelsHome: string
	sessionsDir: string
	transport: Transport
	notify: (n: { content: string; meta: Record<string, string> }) => Promise<void>
	now?: () => number
	/**
	 * Whether a thread handle names a thread that exists. Supplied where thread bookkeeping is
	 * reachable from here; where it is not, a handle is taken on trust and passed through.
	 * A handle that names nothing must fail the call rather than be quietly dropped or
	 * redirected — a typo would otherwise deliver into a conversation nobody chose.
	 */
	knowsThread?: (handle: string) => boolean
	/** Namespace prefix claimed by the bridge, so a session is told apart from a person. */
	namespacePrefix?: string
}

/** Peers that are both in the registry and have a live presence beacon (excluding self). */
export function livePeers(deps: HandlerDeps): PeerIdentity[] {
	const self = deps.self()
	const entries = readSessionEntries(deps.sessionsDir)
	const present = new Set(readBeacons(deps.channelsHome).map((b) => b.sessionId))
	const peers: PeerIdentity[] = []
	for (const entry of entries) {
		if (entry.sessionId === self.sessionId) continue
		if (!present.has(entry.sessionId)) continue
		const id = resolveIdentity(entry.sessionId, [entry])
		if (id) peers.push(id)
	}
	return peers
}

function entryFor(sessionId: string, entries: SessionEntry[]): SessionEntry | undefined {
	return entries.find((e) => e.sessionId === sessionId)
}

/** Turn a stored message into the channel notification payload. */
export function buildChannelNotification(msg: ChannelMessage): {
	content: string
	meta: Record<string, string>
} {
	return { content: msg.text, meta: toChannelMeta(msg) }
}

/**
 * `thread` as a caller writes it: a handle naming an existing thread, or a request for a new
 * one under a title. Deliberately not `ThreadSelector` itself — the tool argument is what a
 * session types, and the selector is what the message carries.
 */
export type ThreadArg = string | { new: string }

export interface SendMessageArgs {
	to: string | string[]
	text: string
	thread?: ThreadArg
}

function toThreadSelector(arg: ThreadArg | undefined): ThreadSelector | undefined {
	if (arg === undefined) return undefined
	if (typeof arg === 'string') return { kind: 'handle', handle: arg }
	return { kind: 'new', title: arg.new }
}

/**
 * What the delivered copies say they were addressed to. A broadcast keeps the raw target it
 * was called with; a single recipient is named outright; several recipients are all listed, so
 * a reader of any one copy can see the whole address.
 */
function messageTo(
	rawTo: string | string[],
	kind: 'session' | 'epic',
	recipients: PeerIdentity[]
): MessageTo {
	if (kind === 'epic') {
		return { kind: 'epic', value: Array.isArray(rawTo) ? rawTo.join(',') : rawTo }
	}
	const ids = recipients.map((r) => r.sessionId)
	const value = ids[0] ?? (Array.isArray(rawTo) ? (rawTo[0] ?? '') : rawTo)
	return ids.length > 1 ? { kind: 'session', value, recipients: ids } : { kind: 'session', value }
}

export function createHandlers(deps: HandlerDeps) {
	const now = deps.now ?? (() => Date.now())

	function whoami(): PeerIdentity {
		return deps.self()
	}

	function listPeers(args: { scope?: 'epic' | 'all' }): PeerListEntry[] {
		const self = deps.self()
		const scope = args.scope ?? (self.epic ? 'epic' : 'all')
		const entries = readSessionEntries(deps.sessionsDir)
		let peers = livePeers(deps)
		if (scope === 'epic' && self.epic) peers = peers.filter((p) => p.epic === self.epic)
		return peers.map((p) => {
			const e = entryFor(p.sessionId, entries)
			return {
				sessionId: p.sessionId,
				shortId: shortId(p.sessionId),
				name: p.name,
				role: p.role,
				epic: p.epic,
				issue: p.issue,
				status: e?.status,
				cwd: e?.cwd,
				lastSeen: e?.updatedAt
			}
		})
	}

	async function readHistory(query: HistoryQuery): Promise<HistoryResult> {
		return deps.transport.history(query)
	}

	/**
	 * A post to a person: local routing is skipped entirely, so no inbox is written and no
	 * session is woken. The destination is the broker's to choose — the room and thread of that
	 * person's most recent mention of this session — and is reported back so the model knows
	 * where it just spoke.
	 */
	async function replyToHuman(to: string, text: string): Promise<SendResult> {
		const posted: MatrixReplyResult = await deps.transport.replyToHuman({ to, text })
		if (!posted.ok) return { ok: false, reason: posted.reason }
		const result: SendResult = { ok: true, kind: 'matrix', to, room: posted.room }
		if (posted.thread !== undefined) result.thread = posted.thread
		return result
	}

	async function sendMessage(args: SendMessageArgs): Promise<SendResult> {
		// Classified ahead of `resolveTargets`: a Matrix address is not a session, so putting it
		// through local resolution could only ever fail — or, worse, match a session whose name
		// happens to contain it.
		if (
			typeof args.to === 'string' &&
			isMatrixAddress(args.to, deps.namespacePrefix ?? DEFAULT_NAMESPACE_PREFIX)
		) {
			return replyToHuman(args.to, args.text)
		}
		const self = deps.self()
		const peers = livePeers(deps)
		const resolution = resolveTargets(args.to, self, peers)
		if (!resolution.ok) {
			return {
				ok: false,
				reason: resolution.reason,
				candidates: resolution.candidates?.map((c) => ({ sessionId: c.sessionId, name: c.name }))
			}
		}
		const thread = toThreadSelector(args.thread)
		if (thread?.kind === 'handle') {
			// Shape first, and without consulting anything: it is the one half of the check that
			// holds in every transport, so it must not depend on a seam that may not be there.
			if (!isThreadHandle(thread.handle)) return { ok: false, reason: 'invalid_thread' }
			// Resolution, only where something here can answer it. Where nothing can, the
			// message is written and the mirror falls back to the room's main timeline rather
			// than dropping a copy that was already delivered locally.
			if (deps.knowsThread?.(thread.handle) === false) {
				return { ok: false, reason: 'thread_not_found' }
			}
		}

		const from: MessageFrom = {
			sessionId: self.sessionId,
			name: self.name,
			epic: self.epic,
			role: self.role
		}
		const to = messageTo(args.to, resolution.kind, resolution.recipients)

		// One id for the call, not one per recipient: a fan-out is one logical message with N
		// deliveries, and the outbound mirror dedupes by this id. Minting inside the loop would
		// make a three-member broadcast three separate messages to everything downstream.
		const id = newMessageId(now())
		for (const recipient of resolution.recipients) {
			const msg: ChannelMessage = {
				id,
				from,
				to,
				text: args.text,
				createdAt: now()
			}
			if (thread !== undefined) msg.thread = thread
			deps.transport.send(recipient.sessionId, msg)
		}

		return {
			ok: true,
			kind: resolution.kind,
			recipients: resolution.recipients.map((r) => ({ sessionId: r.sessionId, name: r.name })),
			count: resolution.recipients.length
		}
	}

	function start(): () => void {
		// The inbox subscription is keyed once: unlike the name, the registry session id is stable
		// for the life of the session.
		return deps.transport.watch(deps.self().sessionId, (msg) => {
			deps.notify(buildChannelNotification(msg)).catch((err) => {
				process.stderr.write(
					`sessionbus: failed to deliver message ${msg.id}: ${err instanceof Error ? err.message : String(err)}\n`
				)
			})
		})
	}

	return { whoami, listPeers, sendMessage, readHistory, start }
}
