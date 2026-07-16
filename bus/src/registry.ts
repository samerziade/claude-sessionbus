import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { SessionEntry } from './identity.ts'

export interface Beacon {
	sessionId: string
	pid: number
	name: string
	role: string
	epic?: string
	startedAt: number
}

function presentDir(channelsHome: string): string {
	return join(channelsHome, 'present')
}

/** Read every *.json session file, tolerating missing dir and bad files. */
export function readSessionEntries(sessionsDir: string): SessionEntry[] {
	if (!existsSync(sessionsDir)) return []
	const entries: SessionEntry[] = []
	for (const file of readdirSync(sessionsDir)) {
		if (!file.endsWith('.json')) continue
		try {
			const raw = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')) as unknown
			if (isSessionEntry(raw)) entries.push(raw)
		} catch {
			// skip malformed / partially-written files
		}
	}
	return entries
}

function isSessionEntry(v: unknown): v is SessionEntry {
	return (
		typeof v === 'object' &&
		v !== null &&
		typeof (v as Record<string, unknown>).sessionId === 'string' &&
		typeof (v as Record<string, unknown>).name === 'string' &&
		typeof (v as Record<string, unknown>).pid === 'number'
	)
}

/** signal 0 probes existence: ESRCH => dead, EPERM => alive but not ours. */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM'
	}
}

export function writeBeacon(channelsHome: string, beacon: Beacon): void {
	const dir = presentDir(channelsHome)
	mkdirSync(dir, { recursive: true })
	const final = join(dir, `${beacon.sessionId}.json`)
	const tmp = join(dir, `.${beacon.sessionId}.tmp`)
	writeFileSync(tmp, JSON.stringify(beacon))
	renameSync(tmp, final)
}

/** Touch the beacon's mtime so external liveness heuristics see it fresh. */
export function refreshBeacon(channelsHome: string, sessionId: string): void {
	const file = join(presentDir(channelsHome), `${sessionId}.json`)
	if (!existsSync(file)) return
	const now = new Date()
	utimesSync(file, now, now)
}

export function removeBeacon(channelsHome: string, sessionId: string): void {
	rmSync(join(presentDir(channelsHome), `${sessionId}.json`), { force: true })
}

/** Read all beacons, deleting any whose owning process is gone. */
export function readBeacons(channelsHome: string): Beacon[] {
	const dir = presentDir(channelsHome)
	if (!existsSync(dir)) return []
	const beacons: Beacon[] = []
	for (const file of readdirSync(dir)) {
		if (!file.endsWith('.json')) continue
		const path = join(dir, file)
		let beacon: Beacon
		try {
			beacon = JSON.parse(readFileSync(path, 'utf8')) as Beacon
		} catch {
			continue // partially-written/corrupt: skip, do NOT delete a possibly-live beacon
		}
		if (isPidAlive(beacon.pid)) beacons.push(beacon)
		else rmSync(path, { force: true })
	}
	return beacons
}
