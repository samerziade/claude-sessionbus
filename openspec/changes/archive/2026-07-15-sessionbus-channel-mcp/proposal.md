## Why

Separate Claude Code sessions running on the same machine have no way to reach each
other. The concrete pain is the PM/worker epic workflow: a worker session finishes an
OpenSpec or hits a blocker and must interrupt a human to relay it to the PM session,
even though both sessions are alive on the same host. There is no discovery surface and
no transport for one session's context to receive a message from another.

## What Changes

- Introduce `sessionbus`, a [Claude Code channel](https://code.claude.com/docs/en/channels-reference)
  — a stdio MCP server spawned once per session — that lets sessions **discover** and
  **message** one another. A session _sends_ by calling a tool; it _receives_ as a
  `<channel …>` event injected into its context, which drives a turn even when idle.
- Derive each session's **identity** from its Claude Code registry title with no manual
  registration: `epic:2345` → PM, `1234 epic:2345` → worker, anything else → a plain
  peer that still participates fully.
- Coordinate purely through disk — no network service, no daemon: **discovery** via
  Claude Code's session registry (`~/.claude/sessions/*.json`) plus a presence beacon,
  and **transport** via a flat-file mailbox (atomic write + inbox watch).
- Expose three tools: `whoami`, `list_peers`, and `send_message`, with **flexible,
  AI-driven addressing** — a `to` value may be a full/short session id, a name
  substring, `pm` (the PM of the caller's epic), or `epic` (broadcast to the epic).
  `pm`/`epic` are convenience sugar over generic session-to-session addressing.
- Keep the transport behind a `Transport` interface so a future broker daemon is a
  drop-in swap.
- Ship pure Node (v25 native type-stripping, no build step), sole runtime dependency
  `@modelcontextprotocol/sdk`, with paired Vitest unit + integration tests.

## Capabilities

### New Capabilities

- `session-discovery`: identity parsed from the session title, presence beacons with
  pid-based liveness, and the `whoami` / `list_peers` tools that enumerate reachable
  peers from the registry ∩ presence.
- `session-messaging`: flexible `to`-address resolution, the flat-file mailbox
  transport (atomic send, poll, watch, broadcast fan-out, archival), the `send_message`
  tool, and inbound delivery of a message as a `<channel>` notification.

### Modified Capabilities

<!-- None — this is a greenfield tool with no existing specs. -->

## Impact

- **New package** `bus/` (design docs still call it `tools/sessionbus/` / `sessionbus/`
  — renamed): standalone `package.json`, `tsconfig.json`, `src/*.ts` with paired
  `*.test.ts`.
- **New dependency**: `@modelcontextprotocol/sdk` (runtime); `vitest`, `typescript`,
  `@types/node` (dev), all pinned exact.
- **Reads** Claude Code's session registry (`~/.claude/sessions/*.json`) — read-only,
  never mutated.
- **Writes** under `~/.claude/channels/` (presence beacons + mailbox). Roots are
  env-overridable (`SESSIONS_DIR`, `CHANNELS_HOME`) for tests.
- **Adoption follow-up (out of scope here)**: user-level MCP registration in
  `~/.claude.json` and launching sessions with
  `claude --dangerously-load-development-channels server:sessionbus` (channels are a
  research preview).
