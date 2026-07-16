import { describe, expect, it } from 'vitest'
import { parseSessionName, resolveIdentity, type SessionEntry } from './identity.ts'

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
