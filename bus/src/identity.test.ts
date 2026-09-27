import { describe, expect, it } from 'vitest'
import {
	findSelfEntry,
	parseSessionName,
	resolveIdentity,
	resolveSelf,
	type SessionEntry
} from './identity.ts'

describe('parseSessionName', () => {
	it('recognizes a PM session', () => {
		expect(parseSessionName('epic:2345')).toEqual({ role: 'pm', epic: '2345' })
	})

	it('recognizes a worker session and extracts the issue', () => {
		expect(parseSessionName('1234 epic:2345')).toEqual({
			role: 'worker',
			issue: '1234',
			epic: '2345'
		})
	})

	it('treats an unstructured name as a plain peer', () => {
		expect(parseSessionName('main-8d')).toEqual({ role: 'none' })
	})

	it('trims surrounding whitespace before matching', () => {
		expect(parseSessionName('  epic:7 ')).toEqual({ role: 'pm', epic: '7' })
	})

	it('returns none for empty/blank names', () => {
		expect(parseSessionName('')).toEqual({ role: 'none' })
		expect(parseSessionName('   ')).toEqual({ role: 'none' })
	})
})

describe('resolveIdentity', () => {
	const entries: SessionEntry[] = [
		{ sessionId: 'aaa', pid: 1, name: 'epic:2345' },
		{ sessionId: 'bbb', pid: 2, name: '1234 epic:2345' }
	]

	it('finds the matching entry and parses its name', () => {
		expect(resolveIdentity('bbb', entries)).toEqual({
			sessionId: 'bbb',
			name: '1234 epic:2345',
			role: 'worker',
			issue: '1234',
			epic: '2345'
		})
	})

	it('returns null when no entry matches', () => {
		expect(resolveIdentity('zzz', entries)).toBeNull()
	})
})

describe('resolveSelf', () => {
	// Mirrors a real `claude --resume` launch: Claude Code mints a throwaway session id at
	// process start, hands it to the MCP server via CLAUDE_CODE_SESSION_ID, then swaps in the
	// resumed conversation's real id and rewrites the registry. Only the pid stays constant.
	const RESUMED: SessionEntry = { sessionId: 'f37a1b2c', pid: 22618, name: 'epic:1081' }
	const OTHER: SessionEntry = { sessionId: '338a3fa0', pid: 23047, name: '1087 epic:1081' }
	const STALE_ENV_ID = '13cdbad7'

	it('identifies the session by pid when the env session id was discarded by --resume', () => {
		expect(resolveSelf(22618, STALE_ENV_ID, [RESUMED, OTHER])).toEqual({
			sessionId: 'f37a1b2c',
			name: 'epic:1081',
			role: 'pm',
			epic: '1081'
		})
	})

	it('prefers the pid match over an env id that resolves to a different session', () => {
		const ghost: SessionEntry = { sessionId: STALE_ENV_ID, pid: 999, name: 'main-f4' }
		expect(resolveSelf(22618, STALE_ENV_ID, [ghost, RESUMED])).toMatchObject({
			sessionId: 'f37a1b2c',
			name: 'epic:1081'
		})
	})

	it('falls back to the env session id when no entry carries our pid', () => {
		expect(resolveSelf(555, '338a3fa0', [RESUMED, OTHER])).toMatchObject({
			sessionId: '338a3fa0',
			role: 'worker',
			issue: '1087'
		})
	})

	it('returns null when neither the pid nor the env id matches an entry', () => {
		expect(resolveSelf(555, 'nope', [RESUMED, OTHER])).toBeNull()
	})

	it('returns null when there is no env id and no pid match', () => {
		expect(resolveSelf(555, undefined, [RESUMED])).toBeNull()
	})

	it('re-parses the name on each call so a post-launch rename is picked up', () => {
		const before = resolveSelf(22618, STALE_ENV_ID, [{ ...RESUMED, name: 'main-f4' }])
		const after = resolveSelf(22618, STALE_ENV_ID, [RESUMED])
		expect(before).toMatchObject({ name: 'main-f4', role: 'none' })
		expect(after).toMatchObject({ name: 'epic:1081', role: 'pm', epic: '1081' })
	})
})

describe('findSelfEntry', () => {
	const entries = [
		{ sessionId: 'discarded', pid: 111, name: 'epic:1', cwd: '/a' },
		{ sessionId: 'real', pid: 222, name: '123 epic:1', cwd: '/b' }
	]

	it('prefers the entry owned by our parent pid', () => {
		expect(findSelfEntry(222, 'discarded', entries)?.cwd).toBe('/b')
	})

	it('falls back to the env session id when no entry owns our pid', () => {
		expect(findSelfEntry(999, 'discarded', entries)?.cwd).toBe('/a')
	})

	it('returns nothing when neither matches', () => {
		expect(findSelfEntry(999, 'nobody', entries)).toBeUndefined()
		expect(findSelfEntry(999, undefined, entries)).toBeUndefined()
	})
})
