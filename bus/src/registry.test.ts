import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	type Beacon,
	isPidAlive,
	readBeacons,
	readSessionEntries,
	refreshBeacon,
	removeBeacon,
	writeBeacon
} from './registry.ts'

let sessionsDir: string
let channelsHome: string

beforeEach(() => {
	sessionsDir = mkdtempSync(join(tmpdir(), 'sb-sessions-'))
	channelsHome = mkdtempSync(join(tmpdir(), 'sb-home-'))
})

const DEAD_PID = 2_000_000_000 // above max real pid on macOS/Linux -> never alive

describe('readSessionEntries', () => {
	it('reads valid entries and skips malformed / non-json files', () => {
		writeFileSync(
			join(sessionsDir, '1.json'),
			JSON.stringify({ sessionId: 'a', pid: 1, name: 'epic:1' })
		)
		writeFileSync(
			join(sessionsDir, '2.json'),
			JSON.stringify({ sessionId: 'b', pid: 2, name: 'main-8d' })
		)
		writeFileSync(join(sessionsDir, 'broken.json'), '{ not valid')
		writeFileSync(join(sessionsDir, 'note.txt'), 'ignore me')

		const entries = readSessionEntries(sessionsDir)
		expect(entries.map((e) => e.sessionId).sort()).toEqual(['a', 'b'])
	})

	it('returns an empty array when the directory does not exist', () => {
		expect(readSessionEntries(join(sessionsDir, 'nope'))).toEqual([])
	})
})

describe('isPidAlive', () => {
	it('is true for the current process and false for a non-existent pid', () => {
		expect(isPidAlive(process.pid)).toBe(true)
		expect(isPidAlive(DEAD_PID)).toBe(false)
	})
})

describe('beacons', () => {
	const beacon = (over: Partial<Beacon> = {}): Beacon => ({
		sessionId: 's1',
		pid: process.pid,
		name: 'epic:2345',
		role: 'pm',
		epic: '2345',
		startedAt: 1784157712199,
		...over
	})

	it('writes then reads back a live beacon', () => {
		writeBeacon(channelsHome, beacon())
		const read = readBeacons(channelsHome)
		expect(read).toHaveLength(1)
		expect(read[0].sessionId).toBe('s1')
	})

	it('prunes and deletes beacons whose pid is dead', () => {
		writeBeacon(channelsHome, beacon({ sessionId: 'live', pid: process.pid }))
		writeBeacon(channelsHome, beacon({ sessionId: 'dead', pid: DEAD_PID }))
		const read = readBeacons(channelsHome)
		expect(read.map((b) => b.sessionId)).toEqual(['live'])
		expect(existsSync(join(channelsHome, 'present', 'dead.json'))).toBe(false)
	})

	it('removeBeacon deletes the file', () => {
		writeBeacon(channelsHome, beacon({ sessionId: 'gone' }))
		removeBeacon(channelsHome, 'gone')
		expect(readdirSync(join(channelsHome, 'present'))).not.toContain('gone.json')
	})

	it('refreshBeacon advances the mtime of an existing beacon', () => {
		writeBeacon(channelsHome, beacon({ sessionId: 'r1' }))
		const file = join(channelsHome, 'present', 'r1.json')
		const past = new Date(Date.now() - 60_000)
		utimesSync(file, past, past)
		const stale = statSync(file).mtimeMs
		refreshBeacon(channelsHome, 'r1')
		expect(statSync(file).mtimeMs).toBeGreaterThan(stale)
	})

	it('refreshBeacon is a no-op when the beacon file does not exist', () => {
		expect(() => refreshBeacon(channelsHome, 'missing')).not.toThrow()
	})

	it('readBeacons skips but does NOT delete an unparseable beacon file', () => {
		writeBeacon(channelsHome, beacon({ sessionId: 'live', pid: process.pid }))
		mkdirSync(join(channelsHome, 'present'), { recursive: true })
		writeFileSync(join(channelsHome, 'present', 'corrupt.json'), '{ not json')
		const read = readBeacons(channelsHome)
		expect(read.map((b) => b.sessionId)).toEqual(['live'])
		expect(existsSync(join(channelsHome, 'present', 'corrupt.json'))).toBe(true)
	})
})
