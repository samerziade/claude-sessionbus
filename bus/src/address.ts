import type { PeerIdentity } from './identity.ts'

export type Resolution =
	| { ok: true; kind: 'session' | 'epic'; recipients: PeerIdentity[] }
	| { ok: false; reason: 'not_found' | 'ambiguous' | 'no_epic'; candidates?: PeerIdentity[] }

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
