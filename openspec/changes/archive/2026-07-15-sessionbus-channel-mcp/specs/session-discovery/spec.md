## ADDED Requirements

### Requirement: Identity derived from session title

The server SHALL derive a session's identity from its Claude Code registry title with
no manual registration step. It MUST recognize the epic-convention patterns and treat
every other title as a plain, fully-participating peer.

- A title matching `^epic:(\d+)$` SHALL resolve to `role: pm` with `epic` set to the
  captured number.
- A title matching `^(\S+)\s+epic:(\d+)$` SHALL resolve to `role: worker` with `issue`
  and `epic` set to the captured groups.
- Any other title SHALL resolve to `role: none`.
- Surrounding whitespace SHALL be trimmed before matching; a blank title SHALL resolve
  to `role: none`.

#### Scenario: PM title

- **WHEN** a session titled `epic:2345` is parsed
- **THEN** its identity is `{ role: 'pm', epic: '2345' }`

#### Scenario: Worker title

- **WHEN** a session titled `1234 epic:2345` is parsed
- **THEN** its identity is `{ role: 'worker', issue: '1234', epic: '2345' }`

#### Scenario: Unstructured title participates as a plain peer

- **WHEN** a session titled `main-8d` is parsed
- **THEN** its identity is `{ role: 'none' }` and it remains addressable as a peer

#### Scenario: Blank or whitespace title

- **WHEN** an empty or whitespace-only title is parsed
- **THEN** its identity is `{ role: 'none' }`

### Requirement: Own-identity resolution from the registry

On startup the server SHALL resolve its own identity by matching
`CLAUDE_CODE_SESSION_ID` against the session registry and parsing the matched entry's
title. If no entry matches, it SHALL fall back to a name-less `role: none` peer using
its session id so the server still runs.

#### Scenario: Matching registry entry

- **WHEN** the server's session id matches a registry entry titled `1234 epic:2345`
- **THEN** `whoami` returns `{ sessionId, name: '1234 epic:2345', role: 'worker', issue: '1234', epic: '2345' }`

#### Scenario: No matching entry

- **WHEN** no registry entry matches the session id
- **THEN** identity resolution returns null and the server falls back to a `role: none` peer

### Requirement: Tolerant session-registry reader

The server SHALL read `~/.claude/sessions/*.json` (root overridable via `SESSIONS_DIR`),
reading only `*.json` files and skipping malformed or partially-written files without
error. A missing directory SHALL yield an empty list.

#### Scenario: Skips malformed and non-JSON files

- **WHEN** the sessions directory contains two valid entries, one malformed `.json`, and one `.txt` file
- **THEN** only the two valid entries are returned

#### Scenario: Missing directory

- **WHEN** the sessions directory does not exist
- **THEN** an empty list is returned

### Requirement: Presence beacons with pid liveness

Each server SHALL write a presence beacon on startup, refresh it periodically, and
remove it on clean exit, because the registry lists sessions but not whether a session
actually loaded the channel. The beacon file lives at
`~/.claude/channels/present/<sessionId>.json` (root overridable via `CHANNELS_HOME`).
Beacon reads MUST prune (delete) any beacon whose owning process is no longer alive.

- Liveness of a peer SHALL be defined as: a registry entry exists AND a beacon exists
  AND the beacon's pid is alive.
- Pid liveness SHALL be probed with signal `0` (`process.kill(pid, 0)`): success or
  `EPERM` means alive; `ESRCH` means dead.

#### Scenario: Write then read back a live beacon

- **WHEN** a beacon is written for a live pid and beacons are read
- **THEN** the beacon is returned

#### Scenario: Dead-pid beacons are pruned on read

- **WHEN** beacons exist for one live pid and one dead pid and beacons are read
- **THEN** only the live beacon is returned AND the dead beacon file is deleted

#### Scenario: Beacon removed on clean exit

- **WHEN** the server removes its beacon on shutdown
- **THEN** the beacon file no longer exists

### Requirement: whoami tool

The server SHALL expose a `whoami` tool that returns the caller's resolved identity
(`sessionId`, `name`, `role`, and `epic`/`issue` when present) so the model can reason
about itself when composing and routing messages.

#### Scenario: Returns caller identity

- **WHEN** a worker session calls `whoami`
- **THEN** it receives its own `{ sessionId, name, role: 'worker', issue, epic }`

### Requirement: list_peers tool

The server SHALL expose a `list_peers({ scope?: 'epic' | 'all' })` tool that returns
reachable peers (registry ∩ live presence), always excluding the caller. `scope: 'epic'`
(the default when the caller is in an epic) SHALL filter to the caller's epic;
`scope: 'all'` SHALL list every reachable session. Each entry SHALL include
`sessionId`, `shortId`, `name`, `role`, `epic`/`issue`, and available registry metadata
(`status`, `cwd`, `lastSeen`).

#### Scenario: Epic scope excludes self and off-epic peers

- **WHEN** a worker in epic `2345` calls `list_peers({ scope: 'epic' })` with a PM peer in the same epic present
- **THEN** the PM peer is returned, the caller itself is excluded, and the entry includes `shortId`, `role`, `epic`, and `status`

#### Scenario: Offline peers are excluded

- **WHEN** a session appears in the registry but has no live presence beacon
- **THEN** it is not returned by `list_peers`
