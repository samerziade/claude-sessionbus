export interface ParsedName {
	role: 'pm' | 'worker' | 'none'
	epic?: string
	issue?: string
}

export interface SessionEntry {
	sessionId: string
	pid: number
	name: string
	cwd?: string
	status?: string
	updatedAt?: number
}

export interface PeerIdentity {
	sessionId: string
	name: string
	role: 'pm' | 'worker' | 'none'
	epic?: string
	issue?: string
}

const PM_RE = /^epic:(\d+)$/
const WORKER_RE = /^(\S+)\s+epic:(\d+)$/

/** Parse a Claude Code session title into a role + epic/issue. */
export function parseSessionName(name: string): ParsedName {
	const trimmed = name.trim()
	const pm = PM_RE.exec(trimmed)
	if (pm) return { role: 'pm', epic: pm[1] }
	const worker = WORKER_RE.exec(trimmed)
	if (worker) return { role: 'worker', issue: worker[1], epic: worker[2] }
	return { role: 'none' }
}

/** Find this session's registry entry by id and derive its identity. */
export function resolveIdentity(sessionId: string, entries: SessionEntry[]): PeerIdentity | null {
	const entry = entries.find((e) => e.sessionId === sessionId)
	if (!entry) return null
	const parsed = parseSessionName(entry.name)
	return { sessionId: entry.sessionId, name: entry.name, ...parsed }
}
