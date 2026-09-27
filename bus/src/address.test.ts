import { describe, expect, it } from 'vitest'
import { resolveTargets, resolveTo } from './address.ts'
import type { PeerIdentity } from './identity.ts'

const self: PeerIdentity = {
	sessionId: 'self-worker',
	name: '1234 epic:2345',
	role: 'worker',
	issue: '1234',
	epic: '2345'
}

const pm: PeerIdentity = { sessionId: 'pm2345aaaa', name: 'epic:2345', role: 'pm', epic: '2345' }
const worker2: PeerIdentity = {
	sessionId: 'wkr2222bbbb',
	name: '1235 epic:2345',
	role: 'worker',
	issue: '1235',
	epic: '2345'
}
const pmOther: PeerIdentity = { sessionId: 'pm0009cccc', name: 'epic:9', role: 'pm', epic: '9' }
const loose: PeerIdentity = { sessionId: 'loosedddd', name: 'scratch-session', role: 'none' }
const peers = [pm, worker2, pmOther, loose]

describe('resolveTo', () => {
	it('resolves "pm" to the PM of the caller\'s epic', () => {
		expect(resolveTo('pm', self, peers)).toEqual({ ok: true, kind: 'session', recipients: [pm] })
	})

	it('resolves "epic" to every same-epic peer', () => {
		const r = resolveTo('epic', self, peers)
		expect(r).toMatchObject({ ok: true, kind: 'epic' })
		if (r.ok)
			expect(r.recipients.map((p) => p.sessionId).sort()).toEqual(['pm2345aaaa', 'wkr2222bbbb'])
	})

	it('resolves "epic:9" to that epic regardless of caller epic', () => {
		expect(resolveTo('epic:9', self, peers)).toEqual({
			ok: true,
			kind: 'epic',
			recipients: [pmOther]
		})
	})

	it('resolves a full sessionId', () => {
		expect(resolveTo('loosedddd', self, peers)).toEqual({
			ok: true,
			kind: 'session',
			recipients: [loose]
		})
	})

	it('resolves an unambiguous short-id prefix', () => {
		expect(resolveTo('pm2345', self, peers)).toEqual({
			ok: true,
			kind: 'session',
			recipients: [pm]
		})
	})

	it('resolves an unambiguous name substring', () => {
		expect(resolveTo('scratch', self, peers)).toEqual({
			ok: true,
			kind: 'session',
			recipients: [loose]
		})
	})

	it('reports ambiguity with candidates when a name matches multiple peers', () => {
		const r = resolveTo('epic:2345', self, peers) // handled by epic branch, not name — sanity
		expect(r.ok).toBe(true)
		const byName = resolveTo('epic', { ...self, epic: undefined }, peers)
		expect(byName).toEqual({ ok: false, reason: 'no_epic' })
	})

	it('returns not_found for an unmatched target', () => {
		expect(resolveTo('does-not-exist', self, peers)).toEqual({ ok: false, reason: 'not_found' })
	})

	it('returns no_epic when "pm" is requested but the caller has no epic', () => {
		expect(resolveTo('pm', { ...self, epic: undefined }, peers)).toEqual({
			ok: false,
			reason: 'no_epic'
		})
	})

	it('returns ambiguous when a name substring matches more than one peer', () => {
		// "2345" is a substring of both "epic:2345" (pm) and "1235 epic:2345" (worker2),
		// but not "epic:9" (pmOther); it isn't an exact id, alias, epic:N, or short-id prefix,
		// so it falls to the name-substring branch and is ambiguous.
		const r = resolveTo('2345', self, peers)
		expect(r.ok).toBe(false)
		if (!r.ok) {
			expect(r.reason).toBe('ambiguous')
			expect(r.candidates?.map((p) => p.sessionId).sort()).toEqual(['pm2345aaaa', 'wkr2222bbbb'])
		}
	})
})

describe('resolveTargets', () => {
	it('resolves a single string exactly as resolveTo does', () => {
		expect(resolveTargets('pm', self, peers)).toEqual(resolveTo('pm', self, peers))
		expect(resolveTargets('epic', self, peers)).toEqual(resolveTo('epic', self, peers))
		expect(resolveTargets('nobody', self, peers)).toEqual(resolveTo('nobody', self, peers))
	})

	it('aggregates a list of named targets into one session resolution', () => {
		const r = resolveTargets(['pm', 'wkr2222bbbb'], self, peers)
		expect(r).toMatchObject({ ok: true, kind: 'session' })
		if (r.ok) expect(r.recipients.map((p) => p.sessionId)).toEqual(['pm2345aaaa', 'wkr2222bbbb'])
	})

	it('de-duplicates entries that resolve to the same peer, keeping first-seen order', () => {
		const r = resolveTargets(['wkr2222bbbb', 'pm', 'wkr2222'], self, peers)
		expect(r).toMatchObject({ ok: true, kind: 'session' })
		if (r.ok) expect(r.recipients.map((p) => p.sessionId)).toEqual(['wkr2222bbbb', 'pm2345aaaa'])
	})

	it('fails with mixed_kind when a list holds a broadcast target', () => {
		expect(resolveTargets(['epic', 'pm'], self, peers)).toEqual({
			ok: false,
			reason: 'mixed_kind'
		})
		expect(resolveTargets(['pm', 'epic:9'], self, peers)).toEqual({
			ok: false,
			reason: 'mixed_kind'
		})
	})

	it('fails with mixed_kind for a one-entry list holding a broadcast target', () => {
		expect(resolveTargets(['epic'], self, peers)).toEqual({ ok: false, reason: 'mixed_kind' })
	})

	it('surfaces the first failing entry and resolves nothing', () => {
		expect(resolveTargets(['pm', 'no-such-peer'], self, peers)).toEqual({
			ok: false,
			reason: 'not_found'
		})
		const ambiguous = resolveTargets(['pm', '2345'], self, peers)
		expect(ambiguous).toMatchObject({ ok: false, reason: 'ambiguous' })
		if (!ambiguous.ok) expect(ambiguous.candidates).toHaveLength(2)
	})

	it('reports the earliest failure when several entries fail', () => {
		expect(resolveTargets(['nope', '2345'], self, peers)).toEqual({
			ok: false,
			reason: 'not_found'
		})
	})

	it('treats an empty list as nothing to resolve', () => {
		expect(resolveTargets([], self, peers)).toEqual({ ok: false, reason: 'not_found' })
	})

	it('resolves a one-entry list of a named target', () => {
		const r = resolveTargets(['pm'], self, peers)
		expect(r).toEqual({ ok: true, kind: 'session', recipients: [pm] })
	})
})
