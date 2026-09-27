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

/**
 * Derive our own identity from the registry, keyed on the pid of the Claude Code process that
 * spawned us (our parent) rather than CLAUDE_CODE_SESSION_ID.
 *
 * `claude --resume` mints a throwaway session id at launch, exports it to MCP servers, then
 * swaps in the resumed conversation's real id and rewrites the registry — so the env id can name
 * a session that never existed. The pid is stable across that swap, and registry entries are
 * keyed by it. The env id remains a fallback for spawn paths where our parent is not the session
 * (a shell wrapper, say), where it is the only signal we have.
 */
export function findSelfEntry(
	ppid: number,
	envSessionId: string | undefined,
	entries: SessionEntry[]
): SessionEntry | undefined {
	const byPid = entries.find((e) => e.pid === ppid)
	if (byPid) return byPid
	return envSessionId ? entries.find((e) => e.sessionId === envSessionId) : undefined
}

export function resolveSelf(
	ppid: number,
	envSessionId: string | undefined,
	entries: SessionEntry[]
): PeerIdentity | null {
	const entry = findSelfEntry(ppid, envSessionId, entries)
	return entry ? resolveIdentity(entry.sessionId, [entry]) : null
}
