import type { PeerIdentity } from './identity.ts'

export type Resolution =
	| { ok: true; kind: 'session' | 'epic'; recipients: PeerIdentity[] }
	| {
			ok: false
			reason: 'not_found' | 'ambiguous' | 'no_epic' | 'mixed_kind'
			candidates?: PeerIdentity[]
	  }

const EPIC_RE = /^epic:(\d+)$/

/**
 * Resolve a `to` argument to concrete recipients.
 * Order: exact sessionId, "pm", "epic"/"epic:N", short-id prefix, name substring.
 */
export function resolveTo(to: string, self: PeerIdentity, peers: PeerIdentity[]): Resolution {
	const target = to.trim()

	// 1. exact full sessionId
	const exact = peers.find((p) => p.sessionId === target)
	if (exact) return { ok: true, kind: 'session', recipients: [exact] }

	// 2. "pm" -> PM of the caller's epic
	if (target === 'pm') {
		if (!self.epic) return { ok: false, reason: 'no_epic' }
		const pm = peers.find((p) => p.role === 'pm' && p.epic === self.epic)
		return pm ? { ok: true, kind: 'session', recipients: [pm] } : { ok: false, reason: 'not_found' }
	}

	// 3. "epic" (caller's epic) or "epic:N"
	if (target === 'epic') {
		if (!self.epic) return { ok: false, reason: 'no_epic' }
		return { ok: true, kind: 'epic', recipients: peers.filter((p) => p.epic === self.epic) }
	}
	const epicMatch = EPIC_RE.exec(target)
	if (epicMatch) {
		return { ok: true, kind: 'epic', recipients: peers.filter((p) => p.epic === epicMatch[1]) }
	}

	// 4. short-id prefix (>=4 chars) against the hyphen-stripped sessionId
	if (target.length >= 4) {
		const flat = (p: PeerIdentity) => p.sessionId.replace(/-/g, '')
		const prefixHits = peers.filter((p) => flat(p).startsWith(target))
		if (prefixHits.length === 1) return { ok: true, kind: 'session', recipients: prefixHits }
		if (prefixHits.length > 1) return { ok: false, reason: 'ambiguous', candidates: prefixHits }
	}

	// 5. name substring
	const nameHits = peers.filter((p) => p.name.includes(target))
	if (nameHits.length === 1) return { ok: true, kind: 'session', recipients: nameHits }
	if (nameHits.length > 1) return { ok: false, reason: 'ambiguous', candidates: nameHits }

	return { ok: false, reason: 'not_found' }
}

/**
 * Resolve a `to` argument that may name several targets at once. A single string behaves
 * exactly as `resolveTo` does; a list resolves every entry and aggregates the results.
 *
 * A list may name only sessions. An entry that resolves to a broadcast fails the whole call
 * with `mixed_kind` rather than being reinterpreted: one event mentioning a whole room *and*
 * two people by name means something nobody has decided, and guessing it would put a message
 * in front of an audience the caller did not choose. Recipients are de-duplicated by session
 * id, so naming one peer twice — by short id and by name — still delivers one copy.
 */
export function resolveTargets(
	to: string | string[],
	self: PeerIdentity,
	peers: PeerIdentity[]
): Resolution {
	if (!Array.isArray(to)) return resolveTo(to, self, peers)

	const recipients: PeerIdentity[] = []
	const seen = new Set<string>()
	for (const entry of to) {
		const resolved = resolveTo(entry, self, peers)
		// The first failure wins and nothing is delivered: a partial fan-out would leave the
		// caller believing everyone named heard them.
		if (!resolved.ok) return resolved
		if (resolved.kind === 'epic') return { ok: false, reason: 'mixed_kind' }
		for (const recipient of resolved.recipients) {
			if (seen.has(recipient.sessionId)) continue
			seen.add(recipient.sessionId)
			recipients.push(recipient)
		}
	}
	// An empty list named nobody. That is the same answer as naming someone who is not there.
	if (recipients.length === 0) return { ok: false, reason: 'not_found' }
	return { ok: true, kind: 'session', recipients }
}
