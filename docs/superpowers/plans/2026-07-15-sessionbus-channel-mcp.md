# sessionbus Channel MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `sessionbus`, a Claude Code channel (MCP server) that lets separate Claude Code sessions on one machine discover and message each other.

**Architecture:** Each session spawns its own stdio MCP server instance. Instances coordinate purely through disk: **discovery** via Claude Code's session registry (`~/.claude/sessions/*.json`) plus a presence beacon we write, and **transport** via a flat-file mailbox (`~/.claude/channels/bus/<recipient>/*.json`, atomic write + inbox watch). Identity (pm/worker/epic) is parsed from the session title; addressing is generic (`sessionId` / `pm` / `epic` / name), with pm/epic as convenience sugar. Transport sits behind an interface so a broker daemon is a future drop-in swap.

**Tech Stack:** Pure Node (v25, native TypeScript execution — no build step), `@modelcontextprotocol/sdk`, Vitest for tests. Zero native dependencies.

Spec: `docs/superpowers/specs/2026-07-15-sessionbus-channel-mcp-design.md`.

## Global Constraints

- **COMMIT FREEZE (active):** The user has instructed that nothing for sessionbus be committed yet. Do **every** task's work as working-tree files, run the verification (`pnpm test`), but **run the `git commit` step only after the user explicitly lifts the freeze.** Until then, treat the final step of each task as "verify green + leave staged/unstaged on disk."
- **Runtime:** Node `25.9.0`. Local module imports use explicit `.ts` extensions (required by Node's native type-stripping). No TS-only features that need transformation (no `enum`, `namespace`, parameter properties, decorators).
- **Package is standalone:** `tools/sessionbus/` has its own `package.json` and `node_modules`; it is **not** added to `pnpm-workspace.yaml`. Install/test from inside that directory.
- **Exact dependency versions:** install with `pnpm add -E` (no `^`/`~`), matching repo policy.
- **No `any`:** use `unknown` + narrowing or precise types (mirrors repo convention).
- **Paths:** absolute repo root is `/Users/samer/github/styreo/main`. All paths below are relative to it unless absolute.
- **Config roots via env for tests:** code reads `CHANNELS_HOME` (default `~/.claude/channels`) and `SESSIONS_DIR` (default `~/.claude/sessions`); tests point these at temp dirs.

---

## File Structure

```text
tools/sessionbus/
  package.json            # standalone package, type: module, test script
  tsconfig.json           # allowImportingTsExtensions, noEmit
  README.md               # what it is, registration, launch flag, smoke test
  src/
    message.ts            # ChannelMessage type, id generation, <channel> meta mapping
    identity.ts           # session-name parsing + own-identity resolution (pure)
    registry.ts           # read ~/.claude/sessions/*.json, presence beacons, pid liveness (I/O)
    mailbox.ts            # Transport interface + flat-file impl: send / poll / watch (I/O)
    address.ts            # resolve a `to` string -> recipient sessionId(s) (pure)
    handlers.ts           # DI-friendly tool handlers + inbound->notification bridge
    index.ts              # main(): build real deps, wire MCP Server, connect stdio
    message.test.ts
    identity.test.ts
    registry.test.ts
    mailbox.test.ts
    address.test.ts
    handlers.test.ts
```

Module dependency order (no cycles): `message` and `identity` are leaves; `registry` uses `identity` types; `mailbox` uses `message`; `address` uses `identity`; `handlers` uses all; `index` wires `handlers` to a real MCP `Server`.

---

## Task 1: Package scaffold + message module

**Files:**

- Create: `tools/sessionbus/package.json`, `tools/sessionbus/tsconfig.json`
- Create: `tools/sessionbus/src/message.ts`
- Test: `tools/sessionbus/src/message.test.ts`

**Interfaces:**

- Produces:
  - `interface MessageFrom { sessionId: string; name: string; epic?: string; role: 'pm' | 'worker' | 'none' }`
  - `interface MessageTo { kind: 'session' | 'epic'; value: string }`
  - `interface ChannelMessage { id: string; from: MessageFrom; to: MessageTo; text: string; createdAt: number }`
  - `function newMessageId(now: number, rand?: string): string`
  - `function shortId(sessionId: string): string`
  - `function toChannelMeta(msg: ChannelMessage): Record<string, string>`

- [ ] **Step 1: Create the package manifest**

Create `tools/sessionbus/package.json`:

```json
{
  "name": "sessionbus",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "description": "Claude Code channel MCP server connecting sessions",
  "scripts": {
    "test": "vitest run",
    "start": "node src/index.ts"
  }
}
```

- [ ] **Step 2: Install dependencies (exact versions)**

Run (from `tools/sessionbus/`):

```bash
cd /Users/samer/github/styreo/main/tools/sessionbus
pnpm add -E --ignore-workspace @modelcontextprotocol/sdk
pnpm add -E -D --ignore-workspace vitest typescript @types/node
```

**`--ignore-workspace` is required.** Without it, because the repo root has a `pnpm-workspace.yaml`, pnpm walks up and folds this directory into the monorepo install — polluting the root `pnpm-lock.yaml` (adds a `tools/sessionbus:` importer + ~400 transitive packages) and symlinking deps into the root store instead of a local one. `--ignore-workspace` keeps the package genuinely standalone: a package-local `pnpm-lock.yaml` + local store, root lockfile untouched.

Expected: `tools/sessionbus/package.json` gains `dependencies.@modelcontextprotocol/sdk` and dev `vitest`/`typescript`/`@types/node` (all pinned without `^`), a `tools/sessionbus/pnpm-lock.yaml` is created, and `git status pnpm-lock.yaml` at the repo root is clean.

- [ ] **Step 3: Create tsconfig**

Create `tools/sessionbus/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Write the failing test**

Create `tools/sessionbus/src/message.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { newMessageId, shortId, toChannelMeta, type ChannelMessage } from './message.ts'

const baseMsg = (over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id: 'zz-0000',
  from: { sessionId: '40b1b2a0-faee-4aa6-aa2c-a56535b547dd', name: '1234 epic:2345', epic: '2345', role: 'worker' },
  to: { kind: 'session', value: 'other' },
  text: 'hello',
  createdAt: 1784157712199,
  ...over,
})

describe('newMessageId', () => {
  it('encodes the timestamp in base36 with the random suffix', () => {
    expect(newMessageId(1000, 'abcd')).toBe((1000).toString(36) + '-abcd')
  })

  it('produces distinct ids for distinct random suffixes', () => {
    expect(newMessageId(1000, 'aaaa')).not.toBe(newMessageId(1000, 'bbbb'))
  })
})

describe('shortId', () => {
  it('strips hyphens and takes the first six hex chars', () => {
    expect(shortId('40b1b2a0-faee-4aa6-aa2c-a56535b547dd')).toBe('40b1b2')
  })
})

describe('toChannelMeta', () => {
  it('maps identifier-safe keys and stringifies values', () => {
    const meta = toChannelMeta(baseMsg())
    expect(meta).toEqual({
      from: '1234 epic:2345',
      from_id: '40b1b2',
      role: 'worker',
      epic: '2345',
      msg_id: 'zz-0000',
    })
    // no hyphenated keys (the channel contract silently drops them)
    expect(Object.keys(meta).some((k) => k.includes('-'))).toBe(false)
  })

  it('omits epic when the sender has none', () => {
    const meta = toChannelMeta(baseMsg({ from: { sessionId: 'x', name: 'main-8d', role: 'none' } }))
    expect(meta.epic).toBeUndefined()
    expect(meta.role).toBe('none')
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test`
Expected: FAIL — cannot resolve `./message.ts` (module not created yet).

- [ ] **Step 6: Implement `message.ts`**

Create `tools/sessionbus/src/message.ts`:

```ts
import { randomBytes } from 'node:crypto'

export interface MessageFrom {
  sessionId: string
  name: string
  epic?: string
  role: 'pm' | 'worker' | 'none'
}

export interface MessageTo {
  kind: 'session' | 'epic'
  value: string
}

export interface ChannelMessage {
  id: string
  from: MessageFrom
  to: MessageTo
  text: string
  createdAt: number
}

/** Sortable, dependency-free id: base36(timestamp) + '-' + random hex. */
export function newMessageId(now: number, rand: string = randomBytes(4).toString('hex')): string {
  return now.toString(36) + '-' + rand
}

/** First six hex chars of a session UUID, hyphens removed — used as from_id. */
export function shortId(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 6)
}

/**
 * Build the <channel> tag attributes. Keys must be identifier-safe
 * (letters/digits/underscore); the channel contract silently drops others.
 */
export function toChannelMeta(msg: ChannelMessage): Record<string, string> {
  const meta: Record<string, string> = {
    from: msg.from.name,
    from_id: shortId(msg.from.sessionId),
    role: msg.from.role,
    msg_id: msg.id,
  }
  if (msg.from.epic) meta.epic = msg.from.epic
  return meta
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test`
Expected: PASS (all `message` tests green).

- [ ] **Step 8: Commit (only if the commit freeze has been lifted)**

```bash
git add tools/sessionbus/package.json tools/sessionbus/tsconfig.json tools/sessionbus/pnpm-lock.yaml tools/sessionbus/src/message.ts tools/sessionbus/src/message.test.ts
git commit -m "feat(sessionbus): scaffold package + message id/meta module"
```

---

## Task 2: Identity — parse session name & resolve own identity

**Files:**

- Create: `tools/sessionbus/src/identity.ts`
- Test: `tools/sessionbus/src/identity.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `interface ParsedName { role: 'pm' | 'worker' | 'none'; epic?: string; issue?: string }`
  - `interface SessionEntry { sessionId: string; pid: number; name: string; cwd?: string; status?: string; updatedAt?: number }`
  - `interface PeerIdentity { sessionId: string; name: string; role: 'pm' | 'worker' | 'none'; epic?: string; issue?: string }`
  - `function parseSessionName(name: string): ParsedName`
  - `function resolveIdentity(sessionId: string, entries: SessionEntry[]): PeerIdentity | null`

- [ ] **Step 1: Write the failing test**

Create `tools/sessionbus/src/identity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseSessionName, resolveIdentity, type SessionEntry } from './identity.ts'

describe('parseSessionName', () => {
  it('recognizes a PM session', () => {
    expect(parseSessionName('epic:2345')).toEqual({ role: 'pm', epic: '2345' })
  })

  it('recognizes a worker session and extracts the issue', () => {
    expect(parseSessionName('1234 epic:2345')).toEqual({ role: 'worker', issue: '1234', epic: '2345' })
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
    { sessionId: 'bbb', pid: 2, name: '1234 epic:2345' },
  ]

  it('finds the matching entry and parses its name', () => {
    expect(resolveIdentity('bbb', entries)).toEqual({
      sessionId: 'bbb',
      name: '1234 epic:2345',
      role: 'worker',
      issue: '1234',
      epic: '2345',
    })
  })

  it('returns null when no entry matches', () => {
    expect(resolveIdentity('zzz', entries)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test identity`
Expected: FAIL — `./identity.ts` not found.

- [ ] **Step 3: Implement `identity.ts`**

Create `tools/sessionbus/src/identity.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test identity`
Expected: PASS.

- [ ] **Step 5: Commit (only if the commit freeze has been lifted)**

```bash
git add tools/sessionbus/src/identity.ts tools/sessionbus/src/identity.test.ts
git commit -m "feat(sessionbus): session-name parsing + own-identity resolution"
```

---

## Task 3: Registry & presence — read sessions, write beacons, pid liveness

**Files:**

- Create: `tools/sessionbus/src/registry.ts`
- Test: `tools/sessionbus/src/registry.test.ts`

**Interfaces:**

- Consumes: `SessionEntry` from `identity.ts`.
- Produces:
  - `interface Beacon { sessionId: string; pid: number; name: string; role: string; epic?: string; startedAt: number }`
  - `function readSessionEntries(sessionsDir: string): SessionEntry[]`
  - `function isPidAlive(pid: number): boolean`
  - `function writeBeacon(channelsHome: string, beacon: Beacon): void`
  - `function refreshBeacon(channelsHome: string, sessionId: string): void`
  - `function removeBeacon(channelsHome: string, sessionId: string): void`
  - `function readBeacons(channelsHome: string): Beacon[]` (prunes dead-pid beacons)

- [ ] **Step 1: Write the failing test**

Create `tools/sessionbus/src/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readSessionEntries,
  isPidAlive,
  writeBeacon,
  readBeacons,
  removeBeacon,
  type Beacon,
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
    writeFileSync(join(sessionsDir, '1.json'), JSON.stringify({ sessionId: 'a', pid: 1, name: 'epic:1' }))
    writeFileSync(join(sessionsDir, '2.json'), JSON.stringify({ sessionId: 'b', pid: 2, name: 'main-8d' }))
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
    ...over,
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
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test registry`
Expected: FAIL — `./registry.ts` not found.

- [ ] **Step 3: Implement `registry.ts`**

Create `tools/sessionbus/src/registry.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
    typeof (v as Record<string, unknown>).name === 'string'
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
  writeFileSync(join(dir, `${beacon.sessionId}.json`), JSON.stringify(beacon))
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
    try {
      const beacon = JSON.parse(readFileSync(path, 'utf8')) as Beacon
      if (isPidAlive(beacon.pid)) beacons.push(beacon)
      else rmSync(path, { force: true })
    } catch {
      rmSync(path, { force: true })
    }
  }
  return beacons
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test registry`
Expected: PASS.

- [ ] **Step 5: Commit (only if the commit freeze has been lifted)**

```bash
git add tools/sessionbus/src/registry.ts tools/sessionbus/src/registry.test.ts
git commit -m "feat(sessionbus): session registry reader + presence beacons + pid liveness"
```

---

## Task 4: Mailbox — flat-file transport (send / poll / watch)

**Files:**

- Create: `tools/sessionbus/src/mailbox.ts`
- Test: `tools/sessionbus/src/mailbox.test.ts`

**Interfaces:**

- Consumes: `ChannelMessage` from `message.ts`.
- Produces:
  - `interface Transport { send(recipientSessionId, msg): void; poll(ownSessionId): ChannelMessage[]; watch(ownSessionId, onMessage): () => void }`
  - `function createFileMailbox(channelsHome: string): Transport`
  - `poll(ownSessionId)` performs one inbox scan: returns newly-seen messages (id-deduped within the instance) and archives their files to `consumed/`.

- [ ] **Step 1: Write the failing test**

Create `tools/sessionbus/src/mailbox.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileMailbox } from './mailbox.ts'
import type { ChannelMessage } from './message.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sb-mb-'))
})

const msg = (id: string, text = 'hi'): ChannelMessage => ({
  id,
  from: { sessionId: 'sender', name: '1234 epic:2345', epic: '2345', role: 'worker' },
  to: { kind: 'session', value: 'recipient' },
  text,
  createdAt: 1784157712199,
})

describe('send + poll', () => {
  it('delivers a sent message to the recipient inbox exactly once', () => {
    const mb = createFileMailbox(home)
    mb.send('recipient', msg('aa-1'))

    const first = mb.poll('recipient')
    expect(first.map((m) => m.id)).toEqual(['aa-1'])

    // second poll sees nothing new (file archived + id remembered)
    expect(mb.poll('recipient')).toEqual([])
  })

  it('leaves no .tmp files and archives to consumed/', () => {
    const mb = createFileMailbox(home)
    mb.send('recipient', msg('aa-2'))
    mb.poll('recipient')

    const inbox = join(home, 'bus', 'recipient')
    expect(readdirSync(inbox).filter((f) => f.endsWith('.json'))).toEqual([])
    expect(existsSync(join(inbox, 'consumed', 'aa-2.json'))).toBe(true)
    expect(readdirSync(inbox).some((f) => f.includes('.tmp'))).toBe(false)
  })

  it('delivers messages queued before the recipient started polling (offline case)', () => {
    const mb = createFileMailbox(home)
    mb.send('recipient', msg('aa-3'))
    mb.send('recipient', msg('bb-4'))
    const got = mb.poll('recipient').map((m) => m.id).sort()
    expect(got).toEqual(['aa-3', 'bb-4'])
  })

  it('returns empty for an inbox that never received anything', () => {
    const mb = createFileMailbox(home)
    expect(mb.poll('nobody')).toEqual([])
  })
})

describe('watch', () => {
  it('invokes the callback for a message that arrives after watching starts', async () => {
    const mb = createFileMailbox(home)
    const seen: string[] = []
    const stop = mb.watch('recipient', (m) => seen.push(m.id))
    mb.send('recipient', msg('cc-5'))
    await new Promise((r) => setTimeout(r, 1300)) // allow poll interval to fire
    stop()
    expect(seen).toContain('cc-5')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test mailbox`
Expected: FAIL — `./mailbox.ts` not found.

- [ ] **Step 3: Implement `mailbox.ts`**

Create `tools/sessionbus/src/mailbox.ts`:

```ts
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  watch as fsWatch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { join } from 'node:path'
import type { ChannelMessage } from './message.ts'

export interface Transport {
  /** Write a message into the recipient's inbox (atomic). */
  send(recipientSessionId: string, msg: ChannelMessage): void
  /** One inbox scan: return newly-seen messages and archive their files. */
  poll(ownSessionId: string): ChannelMessage[]
  /** Poll continuously (interval + fs.watch); returns a stop function. */
  watch(ownSessionId: string, onMessage: (msg: ChannelMessage) => void): () => void
}

const POLL_MS = 1000

export function createFileMailbox(channelsHome: string): Transport {
  const delivered = new Set<string>() // per-instance dedup across polls

  function inboxDir(sessionId: string): string {
    return join(channelsHome, 'bus', sessionId)
  }

  function send(recipientSessionId: string, msg: ChannelMessage): void {
    const dir = inboxDir(recipientSessionId)
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${msg.id}.tmp`)
    const final = join(dir, `${msg.id}.json`)
    writeFileSync(tmp, JSON.stringify(msg))
    renameSync(tmp, final) // atomic on same filesystem: readers never see partial
  }

  function poll(ownSessionId: string): ChannelMessage[] {
    const dir = inboxDir(ownSessionId)
    if (!existsSync(dir)) return []
    const consumed = join(dir, 'consumed')
    mkdirSync(consumed, { recursive: true })

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort() // id has a base36 time prefix, so name order ~= arrival order

    const out: ChannelMessage[] = []
    for (const file of files) {
      const path = join(dir, file)
      let msg: ChannelMessage
      try {
        msg = JSON.parse(readFileSync(path, 'utf8')) as ChannelMessage
      } catch {
        continue // partially written; a later poll will catch it
      }
      if (!delivered.has(msg.id)) {
        delivered.add(msg.id)
        out.push(msg)
      }
      try {
        renameSync(path, join(consumed, file))
      } catch {
        // if archival races with another mover, ignore
      }
    }
    return out
  }

  function watch(ownSessionId: string, onMessage: (msg: ChannelMessage) => void): () => void {
    const dir = inboxDir(ownSessionId)
    mkdirSync(dir, { recursive: true })

    const drain = () => {
      for (const m of poll(ownSessionId)) onMessage(m)
    }

    drain() // pick up anything already queued (offline messages)
    const interval = setInterval(drain, POLL_MS)

    let watcher: FSWatcher | undefined
    try {
      watcher = fsWatch(dir, () => drain()) // low-latency nudge; poll is the safety net
    } catch {
      // fs.watch unsupported here; interval still covers us
    }

    return () => {
      clearInterval(interval)
      watcher?.close()
    }
  }

  return { send, poll, watch }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test mailbox`
Expected: PASS (the `watch` test waits ~1.3s for the poll interval).

- [ ] **Step 5: Commit (only if the commit freeze has been lifted)**

```bash
git add tools/sessionbus/src/mailbox.ts tools/sessionbus/src/mailbox.test.ts
git commit -m "feat(sessionbus): flat-file mailbox transport (send/poll/watch)"
```

---

## Task 5: Address resolution — turn a `to` string into recipients

**Files:**

- Create: `tools/sessionbus/src/address.ts`
- Test: `tools/sessionbus/src/address.test.ts`

**Interfaces:**

- Consumes: `PeerIdentity` from `identity.ts`.
- Produces:
  - `type Resolution = { ok: true; kind: 'session' | 'epic'; recipients: PeerIdentity[] } | { ok: false; reason: 'not_found' | 'ambiguous' | 'no_epic'; candidates?: PeerIdentity[] }`
  - `function resolveTo(to: string, self: PeerIdentity, peers: PeerIdentity[]): Resolution`
  - Resolution order: exact full `sessionId` → `pm` → `epic`/`epic:N` → short-id prefix (≥4 chars) → name substring.

- [ ] **Step 1: Write the failing test**

Create `tools/sessionbus/src/address.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveTo } from './address.ts'
import type { PeerIdentity } from './identity.ts'

const self: PeerIdentity = { sessionId: 'self-worker', name: '1234 epic:2345', role: 'worker', issue: '1234', epic: '2345' }

const pm: PeerIdentity = { sessionId: 'pm2345aaaa', name: 'epic:2345', role: 'pm', epic: '2345' }
const worker2: PeerIdentity = { sessionId: 'wkr2222bbbb', name: '1235 epic:2345', role: 'worker', issue: '1235', epic: '2345' }
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
    if (r.ok) expect(r.recipients.map((p) => p.sessionId).sort()).toEqual(['pm2345aaaa', 'wkr2222bbbb'])
  })

  it('resolves "epic:9" to that epic regardless of caller epic', () => {
    expect(resolveTo('epic:9', self, peers)).toEqual({ ok: true, kind: 'epic', recipients: [pmOther] })
  })

  it('resolves a full sessionId', () => {
    expect(resolveTo('loosedddd', self, peers)).toEqual({ ok: true, kind: 'session', recipients: [loose] })
  })

  it('resolves an unambiguous short-id prefix', () => {
    expect(resolveTo('pm2345', self, peers)).toEqual({ ok: true, kind: 'session', recipients: [pm] })
  })

  it('resolves an unambiguous name substring', () => {
    expect(resolveTo('scratch', self, peers)).toEqual({ ok: true, kind: 'session', recipients: [loose] })
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
    expect(resolveTo('pm', { ...self, epic: undefined }, peers)).toEqual({ ok: false, reason: 'no_epic' })
  })

  it('returns ambiguous when a name substring matches more than one peer', () => {
    const r = resolveTo('epic:2345 ', self, peers) // trailing space -> falls to name path
    // name substring "epic:2345" appears in both pm.name and worker2.name
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous')
      expect(r.candidates?.map((p) => p.sessionId).sort()).toEqual(['pm2345aaaa', 'wkr2222bbbb'])
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test address`
Expected: FAIL — `./address.ts` not found.

- [ ] **Step 3: Implement `address.ts`**

Create `tools/sessionbus/src/address.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test address`
Expected: PASS.

- [ ] **Step 5: Commit (only if the commit freeze has been lifted)**

```bash
git add tools/sessionbus/src/address.ts tools/sessionbus/src/address.test.ts
git commit -m "feat(sessionbus): flexible to-address resolution"
```

---

## Task 6: Handlers — tools + inbound bridge (dependency-injected)

**Files:**

- Create: `tools/sessionbus/src/handlers.ts`
- Test: `tools/sessionbus/src/handlers.test.ts`

**Interfaces:**

- Consumes: `Transport` (mailbox), `readSessionEntries`/`readBeacons` (registry), `resolveIdentity` (identity), `resolveTo` (address), `newMessageId`/`toChannelMeta` (message).
- Produces:
  - `interface PeerListEntry { sessionId: string; shortId: string; name: string; role: string; epic?: string; issue?: string; status?: string; cwd?: string; lastSeen?: number }`
  - `type SendResult = { ok: true; kind: 'session' | 'epic'; recipients: { sessionId: string; name: string }[]; count: number } | { ok: false; reason: string; candidates?: { sessionId: string; name: string }[] }`
  - `interface HandlerDeps { self: PeerIdentity; channelsHome: string; sessionsDir: string; transport: Transport; notify(n: { content: string; meta: Record<string, string> }): Promise<void>; now?: () => number }`
  - `function livePeers(deps): PeerIdentity[]`
  - `function buildChannelNotification(msg: ChannelMessage): { content: string; meta: Record<string, string> }`
  - `function createHandlers(deps): { whoami(): PeerIdentity; listPeers(a: { scope?: 'epic' | 'all' }): PeerListEntry[]; sendMessage(a: { to: string; text: string }): SendResult; start(): () => void }`

- [ ] **Step 1: Write the failing test**

Create `tools/sessionbus/src/handlers.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandlers, buildChannelNotification, type HandlerDeps } from './handlers.ts'
import { createFileMailbox } from './mailbox.ts'
import { writeBeacon } from './registry.ts'
import type { PeerIdentity } from './identity.ts'

let home: string
let sessionsDir: string

const workerSelf: PeerIdentity = { sessionId: 'wkr-1234', name: '1234 epic:2345', role: 'worker', issue: '1234', epic: '2345' }
const pmSelf: PeerIdentity = { sessionId: 'pm-2345', name: 'epic:2345', role: 'pm', epic: '2345' }

function seedRegistry() {
  // both sessions live in the registry + presence, both pids alive (use ours)
  writeFileSync(join(sessionsDir, 'w.json'), JSON.stringify({ sessionId: 'wkr-1234', pid: process.pid, name: '1234 epic:2345', status: 'busy', cwd: '/repo', updatedAt: 111 }))
  writeFileSync(join(sessionsDir, 'p.json'), JSON.stringify({ sessionId: 'pm-2345', pid: process.pid, name: 'epic:2345', status: 'idle', cwd: '/repo', updatedAt: 222 }))
  writeBeacon(home, { sessionId: 'wkr-1234', pid: process.pid, name: '1234 epic:2345', role: 'worker', epic: '2345', startedAt: 1 })
  writeBeacon(home, { sessionId: 'pm-2345', pid: process.pid, name: 'epic:2345', role: 'pm', epic: '2345', startedAt: 1 })
}

function deps(self: PeerIdentity, notify = vi.fn().mockResolvedValue(undefined)): HandlerDeps {
  return { self, channelsHome: home, sessionsDir, transport: createFileMailbox(home), notify, now: () => 1000 }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sb-h-'))
  sessionsDir = mkdtempSync(join(tmpdir(), 'sb-s-'))
  mkdirSync(sessionsDir, { recursive: true })
  seedRegistry()
})

describe('whoami', () => {
  it('returns the caller identity', () => {
    expect(createHandlers(deps(workerSelf)).whoami()).toEqual(workerSelf)
  })
})

describe('listPeers', () => {
  it('lists same-epic peers excluding self', () => {
    const peers = createHandlers(deps(workerSelf)).listPeers({ scope: 'epic' })
    expect(peers.map((p) => p.sessionId)).toEqual(['pm-2345'])
    expect(peers[0]).toMatchObject({ role: 'pm', epic: '2345', status: 'idle', shortId: 'pm2345' })
  })
})

describe('sendMessage', () => {
  it('routes "pm" to the PM inbox and reports one recipient', () => {
    const h = createHandlers(deps(workerSelf))
    const res = h.sendMessage({ to: 'pm', text: 'openspec ready for #1234' })
    expect(res).toMatchObject({ ok: true, kind: 'session', count: 1 })
    if (res.ok) expect(res.recipients[0].sessionId).toBe('pm-2345')

    // the PM can now poll its inbox and see the message
    const pmTransport = createFileMailbox(home)
    const got = pmTransport.poll('pm-2345')
    expect(got).toHaveLength(1)
    expect(got[0].text).toBe('openspec ready for #1234')
    expect(got[0].from.name).toBe('1234 epic:2345')
  })

  it('returns not_found without writing when the target is unknown', () => {
    const res = createHandlers(deps(workerSelf)).sendMessage({ to: 'nobody', text: 'x' })
    expect(res).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('start -> inbound bridge', () => {
  it('delivers an incoming message to notify() as a channel event', async () => {
    const notify = vi.fn().mockResolvedValue(undefined)
    const pmHandlers = createHandlers(deps(pmSelf, notify))
    const stop = pmHandlers.start()

    // worker sends to the PM
    createHandlers(deps(workerSelf)).sendMessage({ to: 'pm', text: 'ping' })

    await new Promise((r) => setTimeout(r, 1300))
    stop()

    expect(notify).toHaveBeenCalledTimes(1)
    const arg = notify.mock.calls[0][0]
    expect(arg.content).toBe('ping')
    expect(arg.meta).toMatchObject({ from: '1234 epic:2345', from_id: 'wkr123', role: 'worker', epic: '2345' })
  })
})

describe('buildChannelNotification', () => {
  it('maps content + meta', () => {
    const n = buildChannelNotification({
      id: 'zz-1', from: { sessionId: 'wkr-1234', name: '1234 epic:2345', epic: '2345', role: 'worker' },
      to: { kind: 'session', value: 'pm-2345' }, text: 'body', createdAt: 1,
    })
    expect(n.content).toBe('body')
    expect(n.meta.msg_id).toBe('zz-1')
  })
})
```

Note: `shortId('wkr-1234')` strips the hyphen → `'wkr123'`; that is the expected `from_id` above.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test handlers`
Expected: FAIL — `./handlers.ts` not found.

- [ ] **Step 3: Implement `handlers.ts`**

Create `tools/sessionbus/src/handlers.ts`:

```ts
import { resolveIdentity, type PeerIdentity, type SessionEntry } from './identity.ts'
import { readBeacons, readSessionEntries } from './registry.ts'
import { resolveTo } from './address.ts'
import { newMessageId, shortId, toChannelMeta, type ChannelMessage, type MessageFrom } from './message.ts'
import type { Transport } from './mailbox.ts'

export interface PeerListEntry {
  sessionId: string
  shortId: string
  name: string
  role: string
  epic?: string
  issue?: string
  status?: string
  cwd?: string
  lastSeen?: number
}

export type SendResult =
  | { ok: true; kind: 'session' | 'epic'; recipients: { sessionId: string; name: string }[]; count: number }
  | { ok: false; reason: string; candidates?: { sessionId: string; name: string }[] }

export interface HandlerDeps {
  self: PeerIdentity
  channelsHome: string
  sessionsDir: string
  transport: Transport
  notify: (n: { content: string; meta: Record<string, string> }) => Promise<void>
  now?: () => number
}

/** Peers that are both in the registry and have a live presence beacon (excluding self). */
export function livePeers(deps: HandlerDeps): PeerIdentity[] {
  const entries = readSessionEntries(deps.sessionsDir)
  const present = new Set(readBeacons(deps.channelsHome).map((b) => b.sessionId))
  const peers: PeerIdentity[] = []
  for (const entry of entries) {
    if (entry.sessionId === deps.self.sessionId) continue
    if (!present.has(entry.sessionId)) continue
    const id = resolveIdentity(entry.sessionId, [entry])
    if (id) peers.push(id)
  }
  return peers
}

function entryFor(sessionId: string, entries: SessionEntry[]): SessionEntry | undefined {
  return entries.find((e) => e.sessionId === sessionId)
}

/** Turn a stored message into the channel notification payload. */
export function buildChannelNotification(msg: ChannelMessage): { content: string; meta: Record<string, string> } {
  return { content: msg.text, meta: toChannelMeta(msg) }
}

export function createHandlers(deps: HandlerDeps) {
  const now = deps.now ?? (() => Date.now())

  function whoami(): PeerIdentity {
    return deps.self
  }

  function listPeers(args: { scope?: 'epic' | 'all' }): PeerListEntry[] {
    const scope = args.scope ?? (deps.self.epic ? 'epic' : 'all')
    const entries = readSessionEntries(deps.sessionsDir)
    let peers = livePeers(deps)
    if (scope === 'epic' && deps.self.epic) peers = peers.filter((p) => p.epic === deps.self.epic)
    return peers.map((p) => {
      const e = entryFor(p.sessionId, entries)
      return {
        sessionId: p.sessionId,
        shortId: shortId(p.sessionId),
        name: p.name,
        role: p.role,
        epic: p.epic,
        issue: p.issue,
        status: e?.status,
        cwd: e?.cwd,
        lastSeen: e?.updatedAt,
      }
    })
  }

  function sendMessage(args: { to: string; text: string }): SendResult {
    const peers = livePeers(deps)
    const resolution = resolveTo(args.to, deps.self, peers)
    if (!resolution.ok) {
      return {
        ok: false,
        reason: resolution.reason,
        candidates: resolution.candidates?.map((c) => ({ sessionId: c.sessionId, name: c.name })),
      }
    }

    const from: MessageFrom = { sessionId: deps.self.sessionId, name: deps.self.name, epic: deps.self.epic, role: deps.self.role }
    const to = resolution.kind === 'epic' ? { kind: 'epic' as const, value: args.to } : { kind: 'session' as const, value: resolution.recipients[0]?.sessionId ?? args.to }

    for (const recipient of resolution.recipients) {
      const msg: ChannelMessage = { id: newMessageId(now()), from, to, text: args.text, createdAt: now() }
      deps.transport.send(recipient.sessionId, msg)
    }

    return {
      ok: true,
      kind: resolution.kind,
      recipients: resolution.recipients.map((r) => ({ sessionId: r.sessionId, name: r.name })),
      count: resolution.recipients.length,
    }
  }

  function start(): () => void {
    return deps.transport.watch(deps.self.sessionId, (msg) => {
      void deps.notify(buildChannelNotification(msg))
    })
  }

  return { whoami, listPeers, sendMessage, start }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test handlers`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm test`
Expected: PASS — all six test files green.

- [ ] **Step 6: Commit (only if the commit freeze has been lifted)**

```bash
git add tools/sessionbus/src/handlers.ts tools/sessionbus/src/handlers.test.ts
git commit -m "feat(sessionbus): DI tool handlers (whoami/list_peers/send_message) + inbound bridge"
```

---

## Task 7: MCP server wiring (`index.ts`)

**Files:**

- Create: `tools/sessionbus/src/index.ts`

**Interfaces:**

- Consumes: everything above, plus `@modelcontextprotocol/sdk`.
- Produces: an executable stdio MCP server (`node src/index.ts`). No new test file — this is thin glue verified by the manual smoke test in Task 8. Keep logic in the tested modules; `index.ts` only wires deps, registers tools, and manages the beacon lifecycle.

- [ ] **Step 1: Implement `index.ts`**

Create `tools/sessionbus/src/index.ts`:

```ts
#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolveIdentity, type PeerIdentity } from './identity.ts'
import { readSessionEntries, refreshBeacon, removeBeacon, writeBeacon } from './registry.ts'
import { createFileMailbox } from './mailbox.ts'
import { createHandlers } from './handlers.ts'

const SESSIONS_DIR = process.env.SESSIONS_DIR ?? join(homedir(), '.claude', 'sessions')
const CHANNELS_HOME = process.env.CHANNELS_HOME ?? join(homedir(), '.claude', 'channels')
const BEACON_REFRESH_MS = 30_000

const INSTRUCTIONS =
  'Messages tagged <channel source="sessionbus" ...> are from ANOTHER Claude Code session on this machine. ' +
  'Use the list_peers tool to see reachable sessions and send_message to reach one. The `to` argument accepts ' +
  'a session id (full or short), a session-name substring, "pm" (the PM of your epic), or "epic" (broadcast to ' +
  'your epic). When you receive a message, decide whether to act on it or reply with send_message addressed to ' +
  'the from_id in the tag. Sessions named "epic:<n>" are PMs; "<issue> epic:<n>" are workers — routing hints, not ' +
  'hard rules. If send_message returns ambiguous/not_found, call list_peers and retry with a precise session id.'

async function main(): Promise<void> {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  if (!sessionId) {
    process.stderr.write('sessionbus: CLAUDE_CODE_SESSION_ID not set; not running inside a Claude Code session.\n')
  }

  // Resolve identity from the registry; fall back to a name-less peer if absent.
  const entries = readSessionEntries(SESSIONS_DIR)
  const self: PeerIdentity =
    (sessionId ? resolveIdentity(sessionId, entries) : null) ??
    { sessionId: sessionId ?? 'unknown', name: sessionId ?? 'unknown', role: 'none' }

  const server = new Server(
    { name: 'sessionbus', version: '0.0.1' },
    { capabilities: { experimental: { 'claude/channel': {} }, tools: {} }, instructions: INSTRUCTIONS },
  )

  const transport = createFileMailbox(CHANNELS_HOME)
  const handlers = createHandlers({
    self,
    channelsHome: CHANNELS_HOME,
    sessionsDir: SESSIONS_DIR,
    transport,
    notify: (n) => server.notification({ method: 'notifications/claude/channel', params: n }),
  })

  // Tool discovery
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'whoami',
        description: 'Return this session\'s own identity (sessionId, name, role, epic, issue).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'list_peers',
        description: 'List reachable Claude Code sessions (other than this one) with their role/epic/status.',
        inputSchema: {
          type: 'object',
          properties: { scope: { type: 'string', enum: ['epic', 'all'], description: 'epic = same epic only (default when in an epic); all = every session' } },
          additionalProperties: false,
        },
      },
      {
        name: 'send_message',
        description: 'Send a message to another session. `to` = session id, name substring, "pm", or "epic".',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient: session id (full/short), name substring, "pm", or "epic"/"epic:N"' },
            text: { type: 'string', description: 'The message body' },
          },
          required: ['to', 'text'],
          additionalProperties: false,
        },
      },
    ],
  }))

  // Tool calls
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params
    const args = (rawArgs ?? {}) as Record<string, unknown>
    if (name === 'whoami') {
      return { content: [{ type: 'text', text: JSON.stringify(handlers.whoami(), null, 2) }] }
    }
    if (name === 'list_peers') {
      const scope = args.scope === 'all' || args.scope === 'epic' ? args.scope : undefined
      return { content: [{ type: 'text', text: JSON.stringify(handlers.listPeers({ scope }), null, 2) }] }
    }
    if (name === 'send_message') {
      if (typeof args.to !== 'string' || typeof args.text !== 'string') {
        return { isError: true, content: [{ type: 'text', text: 'send_message requires string "to" and "text".' }] }
      }
      const result = handlers.sendMessage({ to: args.to, text: args.text })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result.ok ? undefined : true }
    }
    throw new Error(`unknown tool: ${name}`)
  })

  await server.connect(new StdioServerTransport())

  // Presence beacon: announce, refresh, and clean up on exit.
  if (sessionId) {
    writeBeacon(CHANNELS_HOME, { sessionId, pid: process.pid, name: self.name, role: self.role, epic: self.epic, startedAt: Date.now() })
    const refresh = setInterval(() => refreshBeacon(CHANNELS_HOME, sessionId), BEACON_REFRESH_MS)
    refresh.unref?.()
    const cleanup = () => {
      removeBeacon(CHANNELS_HOME, sessionId)
      process.exit(0)
    }
    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
    process.on('exit', () => removeBeacon(CHANNELS_HOME, sessionId))
  }

  // Begin watching our inbox -> inject incoming messages as channel events.
  handlers.start()
}

main().catch((err) => {
  process.stderr.write(`sessionbus fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 2: Type-check**

Run: `cd /Users/samer/github/styreo/main/tools/sessionbus && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke-run the process directly (no Claude yet)**

Run:

```bash
cd /Users/samer/github/styreo/main/tools/sessionbus
CLAUDE_CODE_SESSION_ID=test-smoke SESSIONS_DIR=/tmp/sb-smoke-sessions CHANNELS_HOME=/tmp/sb-smoke-home node src/index.ts <<< ''
```

Expected: the process starts, waits on stdio, and exits cleanly on EOF/Ctrl-C without a stack trace. (It will log the missing-registry note only if `CLAUDE_CODE_SESSION_ID` is unset.)

- [ ] **Step 4: Commit (only if the commit freeze has been lifted)**

```bash
git add tools/sessionbus/src/index.ts
git commit -m "feat(sessionbus): MCP server wiring, tools, and presence beacon lifecycle"
```

---

## Task 8: Registration, README & live smoke test

**Files:**

- Create: `tools/sessionbus/README.md`
- Modify: `~/.claude.json` (user-level MCP registration — done by the user/operator, not committed)

**Interfaces:** none (documentation + manual verification of the two spec open questions).

- [ ] **Step 1: Write the README**

Create `tools/sessionbus/README.md`:

```markdown
# sessionbus

A Claude Code **channel** (MCP server) that connects sessions on one machine so they can message each other.

- Discovery: reads Claude Code's session registry (`~/.claude/sessions/*.json`) + our presence beacons.
- Transport: flat-file mailbox under `~/.claude/channels/`.
- Identity: parsed from the session title — `epic:2345` (PM), `1234 epic:2345` (worker), anything else = a plain peer.

## Tools

- `whoami` — this session's parsed identity.
- `list_peers({ scope?: "epic" | "all" })` — reachable sessions.
- `send_message({ to, text })` — `to` = session id (full/short), name substring, `pm`, or `epic`/`epic:N`.

## Register (user-level, all sessions)

Add to `~/.claude.json`:

\`\`\`json
{
  "mcpServers": {
    "sessionbus": { "command": "node", "args": ["/Users/samer/github/styreo/main/tools/sessionbus/src/index.ts"] }
  }
}
\`\`\`

## Launch (research preview)

Channels require the development flag until allowlisted:

\`\`\`bash
claude --dangerously-load-development-channels server:sessionbus
\`\`\`

Suggested shell alias:

\`\`\`bash
alias claude-ch='claude --dangerously-load-development-channels server:sessionbus'
\`\`\`

For PM/worker sessions, add the same flag to however those sessions are launched (e.g. the implement-issue spawn path).
```

- [ ] **Step 2: Register the server for your user**

Add the `mcpServers.sessionbus` entry above to `~/.claude.json` (absolute path). This is operator config, not a repo change.

- [ ] **Step 3: Live smoke test across two sessions**

In two terminals, both in this repo:

Terminal A (will act as a worker):

```bash
claude --dangerously-load-development-channels server:sessionbus
```

Rename this session to `1234 epic:2345` (session rename UI).

Terminal B (will act as PM):

```bash
claude --dangerously-load-development-channels server:sessionbus
```

Rename this session to `epic:2345`.

Then, in Terminal A, ask Claude: *"Use list_peers, then send_message to the pm saying the openspec for #1234 is ready."*

Expected:

- A's `list_peers` shows B as `role: pm, epic: 2345`.
- B's session receives `<channel source="sessionbus" from="1234 epic:2345" role="worker" epic="2345" ...>the openspec for #1234 is ready</channel>` and Claude in B reacts **without you typing** — this verifies spec open question #2 (a notification wakes an idle session).
- Confirm spec open question #1: renaming a session updates `name` in `~/.claude/sessions/<pid>.json` (check the file), which is why `list_peers` reflects the epic.

If B does **not** wake on the injected event, note it: the fallback is that the message still lands in B's inbox and is surfaced on B's next turn; escalate to the daemon design only if push-wake proves unreliable.

- [ ] **Step 4: Commit (only if the commit freeze has been lifted)**

```bash
git add tools/sessionbus/README.md
git commit -m "docs(sessionbus): README with registration, launch flag, and smoke test"
```

---

## Self-Review

**Spec coverage:**

- Topology / two-way channel → Tasks 6–7 (handlers + MCP wiring, `claude/channel` + `tools` capabilities). ✓
- Identity from session title → Task 2 (`parseSessionName`/`resolveIdentity`). ✓
- Discovery via registry + presence beacon → Task 3 (`readSessionEntries`, beacons) + `livePeers` in Task 6. ✓
- Flat-file mailbox (atomic write, watch, consumed/, dedup, offline) → Task 4. ✓
- Broadcast fan-out → `sendMessage` loops over `resolution.recipients` (Task 6); `epic` resolution in Task 5. ✓
- Tools `list_peers` / `send_message` / `whoami` + smart addressing → Tasks 5–7. ✓
- Message format / identifier-safe meta → Task 1 (`toChannelMeta`) + `buildChannelNotification` (Task 6). ✓
- Instructions string → Task 7 (`INSTRUCTIONS`). ✓
- Runtime/packaging/registration + research-preview flag → Tasks 1, 7, 8. ✓
- Delivery semantics / edge cases (dedup, offline, self-exclusion) → Task 4 tests + `livePeers` self-exclusion (Task 6). ✓
- Testing strategy → unit Tasks 1–5, integration Task 6, manual smoke Task 8. ✓
- Non-goals (permission relay, typed messages, daemon) → intentionally omitted; transport interface (Task 4) preserves the daemon swap. ✓
- Open questions #1/#2 → verified in Task 8 smoke test. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step has complete code. ✓

**Type consistency:** `Transport` (send/poll/watch) consistent across Tasks 4/6/7; `PeerIdentity` fields identical in Tasks 2/5/6; `ChannelMessage`/`MessageFrom` from Task 1 used unchanged in Tasks 4/6/7; `shortId` behavior (`wkr-1234` → `wkr123`) matches the Task 6 test expectation. ✓
