import { resolveTo } from './address.ts'
import { type PeerIdentity, resolveIdentity, type SessionEntry } from './identity.ts'
import type { Transport } from './mailbox.ts'
import {
	type ChannelMessage,
	type MessageFrom,
	newMessageId,
	shortId,
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
	| { ok: false; reason: string; candidates?: { sessionId: string; name: string }[] }

export interface HandlerDeps {
	self: PeerIdentity
	channelsHome: string
	sessionsDir: string
	transport: Transport
	notify: (n: { content: string; meta: Record<string, string> }) => Promise<void>
	now?: () => number
}

/** Peers that are both in the registry and have a live presence beacon (excluding self). */
export function livePeers(deps: HandlerDeps): PeerIdentity[] {
	const entries = readSessionEntries(deps.sessionsDir)
	const present = new Set(readBeacons(deps.channelsHome).map((b) => b.sessionId))
	const peers: PeerIdentity[] = []
	for (const entry of entries) {
		if (entry.sessionId === deps.self.sessionId) continue
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

export function createHandlers(deps: HandlerDeps) {
	const now = deps.now ?? (() => Date.now())

	function whoami(): PeerIdentity {
		return deps.self
	}

	function listPeers(args: { scope?: 'epic' | 'all' }): PeerListEntry[] {
		const scope = args.scope ?? (deps.self.epic ? 'epic' : 'all')
		const entries = readSessionEntries(deps.sessionsDir)
		let peers = livePeers(deps)
		if (scope === 'epic' && deps.self.epic) peers = peers.filter((p) => p.epic === deps.self.epic)
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

	function sendMessage(args: { to: string; text: string }): SendResult {
		const peers = livePeers(deps)
		const resolution = resolveTo(args.to, deps.self, peers)
		if (!resolution.ok) {
			return {
				ok: false,
				reason: resolution.reason,
				candidates: resolution.candidates?.map((c) => ({ sessionId: c.sessionId, name: c.name }))
			}
		}

		const from: MessageFrom = {
			sessionId: deps.self.sessionId,
			name: deps.self.name,
			epic: deps.self.epic,
			role: deps.self.role
		}
		const to =
			resolution.kind === 'epic'
				? { kind: 'epic' as const, value: args.to }
				: { kind: 'session' as const, value: resolution.recipients[0]?.sessionId ?? args.to }

		for (const recipient of resolution.recipients) {
			const msg: ChannelMessage = {
				id: newMessageId(now()),
				from,
				to,
				text: args.text,
				createdAt: now()
			}
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
		return deps.transport.watch(deps.self.sessionId, (msg) => {
			deps.notify(buildChannelNotification(msg)).catch((err) => {
				process.stderr.write(
					`sessionbus: failed to deliver message ${msg.id}: ${err instanceof Error ? err.message : String(err)}\n`
				)
			})
		})
	}

	return { whoami, listPeers, sendMessage, start }
}
