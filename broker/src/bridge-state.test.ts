import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type BridgeState, createBridgeState } from './bridge-state.ts'

const BOT = '@cc.bridge:host'
const ROOM = '!epic:host'

const cleanups: Array<() => void> = []
afterEach(() => {
	for (const c of cleanups.splice(0)) c()
})

function tempPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-state-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	return join(dir, 'state.json')
}

function state(path: string): BridgeState {
	return createBridgeState({ path })
}

describe('bridge state (in memory)', () => {
	it('reads back a value the instant it is set, before any flush', () => {
		const s = state(tempPath())
		s.setSyncToken('s-1', BOT)
		s.setCursor('@a:host', ROOM, { token: 's-0', at: 10 })
		s.rememberThread('h-1', '$root-1')

		expect(s.getSyncToken(BOT)).toBe('s-1')
		expect(s.getCursor('@a:host', ROOM)).toEqual({ token: 's-0', at: 10 })
		expect(s.resolveThread('h-1')).toBe('$root-1')
	})

	it('returns nothing for a cursor identity or a thread handle never recorded', () => {
		const s = state(tempPath())
		expect(s.getSyncToken(BOT)).toBeUndefined()
		expect(s.getCursor('@nobody:host', ROOM)).toBeUndefined()
		expect(s.resolveThread('never-seen')).toBeUndefined()
	})
})

describe('bridge state (durability)', () => {
	it('survives into a new instance over the same location once flushed', () => {
		const path = tempPath()
		const first = state(path)
		first.setSyncToken('s-1', BOT)
		first.setCursor('@a:host', ROOM, { token: 's-0', at: 10 })
		first.rememberThread('h-1', '$root-1')
		first.flush()

		const second = state(path)
		expect(second.getSyncToken(BOT)).toBe('s-1')
		expect(second.getCursor('@a:host', ROOM)).toEqual({ token: 's-0', at: 10 })
		expect(second.resolveThread('h-1')).toBe('$root-1')
	})

	it('creates the document when the location does not exist', () => {
		const path = tempPath()
		const s = state(path)
		expect(existsSync(path)).toBe(false)
		expect(s.getSyncToken(BOT)).toBeUndefined()

		s.setSyncToken('s-1', BOT)
		s.flush()

		expect(existsSync(path)).toBe(true)
		expect(state(path).getSyncToken(BOT)).toBe('s-1')
	})

	it('keeps the last write for a key set twice before a flush', () => {
		const path = tempPath()
		const s = state(path)
		s.setCursor('@a:host', ROOM, { token: '$first', at: 10 })
		s.setCursor('@a:host', ROOM, { token: '$second', at: 20 })
		s.flush()

		expect(state(path).getCursor('@a:host', ROOM)?.token).toBe('$second')
	})

	it('leaves a parsable document and no temporary artifact beside it', () => {
		const path = tempPath()
		const s = state(path)
		s.setSyncToken('s-1', BOT)
		s.flush()

		expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow()
		const siblings = readdirSync(join(path, '..'))
		expect(siblings).toEqual(['state.json'])
	})

	it('is idempotent: a second flush with nothing changed leaves the document alone', () => {
		const path = tempPath()
		const s = state(path)
		s.setSyncToken('s-1', BOT)
		s.flush()
		const after = readFileSync(path, 'utf8')

		expect(() => s.flush()).not.toThrow()
		expect(readFileSync(path, 'utf8')).toBe(after)
	})
})

describe('bridge state (tolerant load)', () => {
	it('treats a truncated document as absent on every getter', () => {
		const path = tempPath()
		writeFileSync(path, '{"syncToken":"s-1","cur')

		const s = state(path)
		expect(s.getSyncToken(BOT)).toBeUndefined()
		expect(s.getCursor('@a:host', ROOM)).toBeUndefined()
		expect(s.resolveThread('h-1')).toBeUndefined()
	})

	it('treats a well-formed document of the wrong shape as absent', () => {
		const path = tempPath()
		writeFileSync(path, '["not", "a", "document"]')

		const s = state(path)
		expect(s.getSyncToken(BOT)).toBeUndefined()
		expect(s.getCursor('@a:host', ROOM)).toBeUndefined()
	})

	it('ignores only the malformed field of an otherwise valid document', () => {
		const path = tempPath()
		writeFileSync(
			path,
			JSON.stringify({
				sync: 7,
				cursors: { '@a:host': { [ROOM]: { token: '$e-1', at: 10 } } }
			})
		)

		const s = state(path)
		expect(s.getSyncToken(BOT)).toBeUndefined()
		expect(s.getCursor('@a:host', ROOM)).toEqual({ token: '$e-1', at: 10 })
	})

	it('replaces a malformed document on the next flush', () => {
		const path = tempPath()
		writeFileSync(path, 'not json at all')

		const s = state(path)
		s.setSyncToken('s-1', BOT)
		s.flush()

		expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
			sync: { token: 's-1', botUser: BOT }
		})
		expect(state(path).getSyncToken(BOT)).toBe('s-1')
	})
})

describe('bridge state (read cursors)', () => {
	it('round-trips an opaque cursor token per identity and room', () => {
		const s = state(tempPath())
		s.setCursor('@a:host', '!one:host', { token: 's-7', at: 10 })
		s.setCursor('@a:host', '!two:host', { token: 's-9', at: 11 })
		s.setCursor('@b:host', '!one:host', { token: 's-3', at: 12 })

		expect(s.getCursor('@a:host', '!one:host')).toEqual({ token: 's-7', at: 10 })
		expect(s.getCursor('@a:host', '!two:host')).toEqual({ token: 's-9', at: 11 })
		expect(s.getCursor('@b:host', '!one:host')).toEqual({ token: 's-3', at: 12 })
	})

	it('reads an absent identity/room pair as undefined', () => {
		const s = state(tempPath())
		s.setCursor('@a:host', '!one:host', { token: 's-7', at: 10 })

		expect(s.getCursor('@a:host', '!other:host')).toBeUndefined()
		expect(s.getCursor('@nobody:host', '!one:host')).toBeUndefined()
	})

	it('keeps one room out of another: advancing one leaves the other alone', () => {
		const s = state(tempPath())
		s.setCursor('@a:host', '!one:host', { token: 's-1', at: 10 })
		s.setCursor('@a:host', '!two:host', { token: 's-2', at: 11 })
		s.setCursor('@a:host', '!one:host', { token: 's-3', at: 12 })

		expect(s.getCursor('@a:host', '!two:host')).toEqual({ token: 's-2', at: 11 })
	})

	it('survives a flush into a new instance', () => {
		const path = tempPath()
		const first = state(path)
		first.setCursor('@a:host', '!one:host', { token: 's-7', at: 10 })
		first.flush()

		expect(state(path).getCursor('@a:host', '!one:host')).toEqual({ token: 's-7', at: 10 })
	})
})

describe('bridge state (cursor advance is monotonic)', () => {
	it('keeps the newer position when an older one is applied after it', () => {
		const s = state(tempPath())
		s.setCursor('@a:host', '!one:host', { token: 's-9', at: 200 })
		s.setCursor('@a:host', '!one:host', { token: 's-2', at: 100 })

		expect(s.getCursor('@a:host', '!one:host')).toEqual({ token: 's-9', at: 200 })
	})

	it('is idempotent: the same advance applied twice stores one advance', () => {
		const s = state(tempPath())
		const once = state(tempPath())
		s.setCursor('@a:host', '!one:host', { token: 's-9', at: 200 })
		s.setCursor('@a:host', '!one:host', { token: 's-9', at: 200 })
		once.setCursor('@a:host', '!one:host', { token: 's-9', at: 200 })

		expect(s.getCursor('@a:host', '!one:host')).toEqual(once.getCursor('@a:host', '!one:host'))
	})

	it('takes the later write when two advances land in the same instant', () => {
		const s = state(tempPath())
		s.setCursor('@a:host', '!one:host', { token: 's-1', at: 100 })
		s.setCursor('@a:host', '!one:host', { token: 's-2', at: 100 })

		expect(s.getCursor('@a:host', '!one:host')).toEqual({ token: 's-2', at: 100 })
	})

	it('accepts a newer position after an older one', () => {
		const s = state(tempPath())
		s.setCursor('@a:host', '!one:host', { token: 's-2', at: 100 })
		s.setCursor('@a:host', '!one:host', { token: 's-9', at: 200 })

		expect(s.getCursor('@a:host', '!one:host')).toEqual({ token: 's-9', at: 200 })
	})
})

describe('bridge state (the sync position belongs to one bot identity)', () => {
	it('returns a position recorded under the same bot identity', () => {
		const s = state(tempPath())
		s.setSyncToken('s-1', BOT)

		expect(s.getSyncToken(BOT)).toBe('s-1')
	})

	it('discards a position recorded under a different bot identity', () => {
		const path = tempPath()
		const first = state(path)
		first.setSyncToken('s-1', '@cc.bridge.old:host')
		first.flush()

		expect(state(path).getSyncToken(BOT)).toBeUndefined()
	})

	it('replaces a foreign position rather than merging with it', () => {
		const path = tempPath()
		const first = state(path)
		first.setSyncToken('s-1', '@cc.bridge.old:host')
		first.setSyncToken('s-2', BOT)
		first.flush()

		expect(state(path).getSyncToken(BOT)).toBe('s-2')
		expect(state(path).getSyncToken('@cc.bridge.old:host')).toBeUndefined()
	})
})

describe('bridge state (writes are whole or not at all)', () => {
	it('never leaves a reader a partial document while a later write is unflushed', () => {
		const path = tempPath()
		const s = state(path)
		s.setCursor('@a:host', '!one:host', { token: 's-1', at: 10 })
		s.flush()

		// Set-but-unflushed: a concurrent reader gets the previous complete value, never a
		// half-written newer one.
		s.setCursor('@a:host', '!one:host', { token: 's-2', at: 20 })
		expect(state(path).getCursor('@a:host', '!one:host')).toEqual({ token: 's-1', at: 10 })

		s.flush()
		expect(state(path).getCursor('@a:host', '!one:host')).toEqual({ token: 's-2', at: 20 })
	})

	it('lands a large document whole, with no temporary artifact left beside it', () => {
		const path = tempPath()
		const s = state(path)
		for (let i = 0; i < 500; i += 1) {
			s.setCursor(`@a${i}:host`, `!room${i}:host`, { token: `s-${i}`, at: i })
		}
		s.flush()

		expect(readdirSync(join(path, '..'))).toEqual(['state.json'])
		expect(state(path).getCursor('@a499:host', '!room499:host')).toEqual({
			token: 's-499',
			at: 499
		})
	})

	it('replaces the document by renaming a new one over it, never writing in place', () => {
		// The inode is the observable: a rename puts a *different* file at the path, which is
		// what makes a concurrent reader see either the old document or the new one whole. An
		// in-place write keeps the inode and exposes the truncated middle.
		const path = tempPath()
		const s = state(path)
		s.setSyncToken('s-1', BOT)
		s.flush()
		const before = statSync(path).ino

		s.setSyncToken('s-2', BOT)
		s.flush()

		expect(statSync(path).ino).not.toBe(before)
		expect(state(path).getSyncToken(BOT)).toBe('s-2')
	})

	it('reads a cursor store that cannot be parsed as absent, without raising', () => {
		const path = tempPath()
		writeFileSync(path, '{"cursors":{"@a:host":{"!one:host":{"token":"s-1","at')

		const s = state(path)
		expect(() => s.getCursor('@a:host', '!one:host')).not.toThrow()
		expect(s.getCursor('@a:host', '!one:host')).toBeUndefined()
	})

	it('drops only the cursor rows it cannot make sense of', () => {
		const path = tempPath()
		writeFileSync(
			path,
			JSON.stringify({
				cursors: {
					'@a:host': { '!one:host': { token: 's-1', at: 10 }, '!two:host': 'not a cursor' },
					'@b:host': 'not a room map'
				}
			})
		)

		const s = state(path)
		expect(s.getCursor('@a:host', '!one:host')).toEqual({ token: 's-1', at: 10 })
		expect(s.getCursor('@a:host', '!two:host')).toBeUndefined()
		expect(s.getCursor('@b:host', '!one:host')).toBeUndefined()
	})
})
