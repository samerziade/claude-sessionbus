## Context

Claude Code channels are MCP servers spawned per session over stdio. A channel can
receive (emit `notifications/claude/channel` events that arrive as `<channel …>` blocks
in the session's context) and, if it declares `tools: {}`, send (expose MCP tools the
model calls). The critical consequence: **each session spawns its own server instance**,
and two instances cannot talk directly — they must coordinate through shared state on
disk.

Two Claude Code artifacts and constraints shape the design:

- Claude Code maintains a live **session registry** at `~/.claude/sessions/*.json` (one
  file per running session, with `sessionId`, `pid`, `name`, `status`, `cwd`,
  `updatedAt`), and injects `CLAUDE_CODE_SESSION_ID` into every spawned subprocess.
  Together these are a complete, zero-cost discovery surface we only read.
- Runtime is **Node 25 with native type-stripping** — no build step, but no TS features
  needing transformation (`enum`, `namespace`, decorators, parameter properties), local
  imports use explicit `.ts` extensions, and SDK imports use `.js` specifiers.
- Channels are a **research preview**: sessions must launch with
  `claude --dangerously-load-development-channels server:sessionbus`.

This design covers the greenfield MVP. Motivation and scope are in `proposal.md`;
normative behavior is in `specs/session-discovery/` and `specs/session-messaging/`.

## Goals / Non-Goals

**Goals:**

- Any session running the server can discover other such sessions and send a message
  that arrives in the target's context and drives a turn even when idle.
- Identity derived from the session title, no manual registration.
- Flexible, AI-driven routing; `pm`/`epic` are sugar over generic session addressing.
- Zero-friction runtime: pure Node, no native deps, no build step, no daemon.
- Usable outside the epic workflow — `role: none` sessions are first-class peers.
- Pure modules unit-testable without stdio; transport swappable behind an interface.

**Non-Goals:**

- Permission relay (forwarding tool-approval prompts between sessions).
- Typed milestone message types / templates — MVP is generic free-text.
- A broker daemon — deferred; the `Transport` interface keeps it a drop-in swap.
- Cross-machine messaging — single host only.
- Read receipts — delivery is fire-and-forget per the channel contract.

## Decisions

### Coordinate through disk, not a daemon

Because instances can't talk directly, all coordination is on disk: discovery via the
registry + a presence beacon, transport via a flat-file mailbox.

- **Alternative — central broker daemon (unix socket):** real-time push and a single
  source of truth, but the code is the easy part; the lifecycle is not (startup races
  when many workers launch, crash recovery + reconnect, version handshakes, orphan
  reconciliation). That robustness tax buys millisecond latency that human-read PM↔worker
  messages don't need. Deferred behind the `Transport` interface.
- **Alternative — peer-to-peer sockets:** reinvents the discovery + queueing the
  registry + mailbox give for free. Rejected.

### Presence beacon on top of the registry

The registry lists sessions but not whether a session actually loaded the channel, so
each server writes `~/.claude/channels/present/<sessionId>.json` on startup, refreshes
its mtime (~30s), and removes it on clean exit. Liveness = registry entry ∩ beacon ∩
pid alive (`process.kill(pid, 0)`, treating `EPERM` as alive). Stale beacons are pruned
lazily on read. This distinguishes "session exists" from "session is reachable on the
bus."

### Atomic writes + inbox watch for transport

One message = one file in `bus/<recipient>/<id>.json`. Send writes `.<id>.tmp` then
`rename`s into place — atomic on one filesystem, so readers never see a partial file.
Receive watches the own inbox with `fs.watch` **plus** a ~1s poll fallback (macOS
`fs.watch` can miss events); on a new file it validates JSON, emits the channel
notification, then moves the file to `consumed/`.

- **Delivery is at-least-once.** An in-memory delivered-id `Set` suppresses duplicate
  `fs.watch` fires; moving to `consumed/` prevents re-delivery across restarts. Crash
  mid-consume: file already moved → not re-delivered; not yet moved → re-delivered next
  scan, deduped by id.
- **Sortable ids** (`base36(createdAt)` + random suffix) mean lexical filename sort ≈
  arrival order, so `poll` drains roughly in order with no index.

### Generic addressing with pm/epic as sugar

`resolveTo` tries, in order: exact sessionId → `pm` → `epic`/`epic:N` → short-id prefix
(≥4 chars) → name substring. It never guesses: `not_found`, `ambiguous` (with
candidates), and `no_epic` are explicit results the tool surfaces so the model can
retry with a precise id. This keeps the epic workflow ergonomic while leaving arbitrary
sessions fully addressable.

### Dependency-injected handlers behind a Transport seam

`handlers.ts` takes `HandlerDeps { self, channelsHome, sessionsDir, transport, notify,
now? }`, so tool logic is testable without stdio and discovery/transport are repointable.
`index.ts` is thin glue: it builds real deps, wires the MCP `Server` (capabilities +
three tools + instructions), manages the beacon lifecycle, and connects stdio. Module
dependency order is acyclic: `message`/`identity` are leaves; `registry` uses `identity`
types; `mailbox` uses `message`; `address` uses `identity`; `handlers` uses all;
`index` wires `handlers` to a real `Server`.

### Runtime & packaging

Standalone package (own `package.json` + lockfile + store, installed with
`--ignore-workspace` and exact-pinned deps), pure Node with no build step, sole runtime
dep `@modelcontextprotocol/sdk`. Config roots (`SESSIONS_DIR`, `CHANNELS_HOME`) are
env-overridable so tests point them at temp dirs. Trust boundary: all peers are the same
OS user's local sessions reading a user-owned directory; inbound text is same-user,
single-host, so sender gating is unnecessary for the MVP.

## Risks / Trade-offs

- **`fs.watch` misses events on macOS** → the ~1s poll fallback guarantees eventual
  delivery; latency is ~1s worst case, acceptable for human-read messages.
- **Final-hop can be at-most-once if `notify` rejects** (file archived to `consumed/`
  before notify runs) → recoverable by hand from `consumed/`; the future daemon acks
  before archive, fixing it for free.
- **Frozen self-identity** → `index.ts` resolves `self` once at startup, so a session
  renamed after its server started keeps a stale identity for its own `whoami`/outgoing
  `from`/`pm`/`epic` resolution (peers still reach it fine, since `livePeers` re-derives
  every peer per call). Accepted for MVP; generalization work re-derives `self` per call.
- **Prompt-injection via inbound text** → wrapped as `<channel>` data, but originates
  from another Claude session; accepted for same-user single-host, noted for future
  hardening if the surface widens.
- **Untested `index.ts` glue** → kept intentionally thin (no logic beyond wiring);
  verified by a manual smoke test rather than a unit test.

## Migration Plan

Greenfield — nothing to migrate. Rollout is additive:

1. Land the package and its tests (TDD, module-by-module, all green).
2. Register the server user-level in `~/.claude.json` and add a launch alias that
   includes `--dangerously-load-development-channels server:sessionbus`.
3. Adoption follow-up (tracked separately): ensure PM/worker spawn paths include the
   flag. Rollback is simply removing the MCP registration — no shared schema to unwind
   beyond the `~/.claude/channels/` directory, which is safe to delete.

## Open Questions

- Confirm `~/.claude/sessions/*.json` `name` updates promptly on an interactive rename.
- Confirm a channel notification reliably drives a turn in an idle session waiting on
  user input.
- Confirm the presence-beacon refresh interval and stale-prune threshold (initial:
  refresh ~30s, prune on dead pid).
