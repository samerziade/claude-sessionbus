# sessionbus — Handoff

> Self-contained brief for a fresh Claude session working in this repo. You do **not** need the session that built this. Read this top-to-bottom, then `sessionbus/src/*.ts`.

## TL;DR

`sessionbus` is a **Claude Code channel** — an MCP server, spawned per Claude session over stdio, that lets separate Claude Code sessions on the same machine **discover and message each other**. A session _sends_ by calling a tool; it _receives_ as a `<channel …>` event injected into its context, which drives a turn even when it's idle.

It was designed + built via brainstorm → plan → subagent-driven TDD. **Status: complete MVP, 47 tests passing, `tsc` clean.** Nothing here is on npm; it runs locally.

**Your mission (what the owner wants next):**

1. **Generalize** it — today identity is hardcoded to a `pm`/`worker`/`epic` convention; make the core generic session-to-session messaging with grouping as a pluggable convention.
2. **Install it globally, properly** — user-level MCP registration for all sessions, ergonomic launch, ideally packaged as a plugin.
3. **Build the daemon** transport (the file mailbox was MVP; the owner wants to try a real-time broker). Design is in this doc.

---

## Repo layout

```text
claude-sessionbus/
├── HANDOFF.md                      # this file
├── README.md                       # (repo root — currently empty; fill it in)
├── docs/superpowers/
│   ├── specs/2026-07-15-sessionbus-channel-mcp-design.md   # the design spec
│   └── plans/2026-07-15-sessionbus-channel-mcp.md          # the impl plan (SEE "drift" note)
└── sessionbus/                     # the package (nested one level; flatten if you prefer)
    ├── package.json                # standalone; type:module; scripts: test, start
    ├── tsconfig.json               # NodeNext, allowImportingTsExtensions, noEmit, strict
    ├── pnpm-lock.yaml              # package-local lockfile (installed with --ignore-workspace originally)
    ├── README.md
    └── src/
        ├── message.ts   (+ .test)  # ChannelMessage type, sortable id, <channel> meta mapping
        ├── identity.ts  (+ .test)  # parse session title -> role/epic/issue (PURE)
        ├── registry.ts  (+ .test)  # read ~/.claude/sessions/*.json, presence beacons, pid liveness (I/O)
        ├── mailbox.ts   (+ .test)  # Transport interface + flat-file impl: send/poll/watch (I/O)
        ├── address.ts   (+ .test)  # resolve a `to` string -> recipient sessionId(s) (PURE)
        ├── handlers.ts  (+ .test)  # DI tool handlers (whoami/list_peers/send_message) + inbound->notify bridge
        └── index.ts                # main(): build real deps, wire MCP Server, connect stdio (no unit test — glue)
```

### Run / test / typecheck (from `sessionbus/`)

```bash
cd ~/github/samerziade/claude-sessionbus/sessionbus
pnpm install            # standalone repo now — no --ignore-workspace needed (there's no parent pnpm workspace here)
pnpm test               # vitest run — 47 tests; two tests wait ~1.3s on the mailbox poll interval (expected)
pnpm exec tsc --noEmit  # must be clean
node src/index.ts       # runs the server (Node 25 executes .ts natively — no build step). It waits on stdio; see teardown note below.
```

---

## How Claude Code channels work (contract essentials)

Reference: <https://code.claude.com/docs/en/channels-reference> (research preview). Key facts baked into this code:

- A channel is an MCP server. Declare capability `capabilities.experimental['claude/channel'] = {}` → Claude Code registers a notification listener. Add `tools: {}` to expose reply tools (two-way).
- **Push in:** `server.notification({ method: 'notifications/claude/channel', params: { content, meta } })`. It arrives in the peer's context as `<channel source="<serverName>" k="v" …>content</channel>`. `source` is set automatically from the server name. `meta` keys **must be identifier-safe** (letters/digits/underscore) — hyphenated keys are silently dropped (that's why we use `from_id`, `msg_id`).
- **Send out:** register standard MCP tools via `ListToolsRequestSchema` / `CallToolRequestSchema`.
- Notifications are fire-and-forget (no ack, no read receipt). A channel event injected into an idle session drives a turn (this is the whole point — a worker can notify its PM and the PM acts).
- **Research-preview gate:** custom channels aren't allowlisted, so every session must launch with `--dangerously-load-development-channels server:sessionbus`. There's also a `claude/channel/permission` capability for relaying tool-approval prompts — we do **not** use it yet (future).

---

## Architecture (how sessions coordinate with no server)

Each Claude session spawns its **own** sessionbus instance; instances never talk directly. They coordinate through two on-disk mechanisms:

### 1. Discovery — Claude Code's own session registry (read-only) + our beacons

- `CLAUDE_CODE_SESSION_ID` env var is present in every spawned subprocess → a server always knows its own session id.
- `~/.claude/sessions/<pid>.json` is a live registry Claude Code maintains, one file per running session:

  ```json
  {
    "pid": 60835,
    "sessionId": "40b1b2a0-…",
    "cwd": "/repo",
    "name": "epic:2345",
    "nameSource": "custom",
    "status": "busy",
    "updatedAt": 1784157712199
  }
  ```

  We read it to find our own `name` and to enumerate peers (name, status, cwd). **This is the crux that makes title-based identity work.** When a session is renamed, `name` here updates.

- We additionally write a **presence beacon** `~/.claude/channels/present/<sessionId>.json` on startup (refreshed ~30s, removed on exit). "Live peer" = registry entry ∩ beacon ∩ pid-alive. The beacon proves the channel is actually loaded for that session (a session could launch without the dev flag).

### 2. Transport — flat-file mailbox

```text
~/.claude/channels/
  present/<sessionId>.json              # beacons
  bus/<recipientSessionId>/<id>.json    # one message = one file; atomic write (.tmp + rename)
  bus/<recipientSessionId>/consumed/    # archived after delivery
```

Each server watches **its own** inbox (`fs.watch` + ~1s poll fallback), delivers new messages as channel notifications, archives them. Dedup by id (in-memory `Set`). Broadcast = fan out one file per epic member. At-least-once (mostly — see open item #2).

### Identity (parsed from session title, `identity.ts`)

- `^epic:(\d+)$` → `role: pm`, `epic: N`
- `^(\S+)\s+epic:(\d+)$` → `role: worker`, `issue: $1`, `epic: N`
- else → `role: none` (still a full peer — just no epic/pm sugar). **This "none" path is why it already works outside the epic workflow.**

### Tools (`handlers.ts` → wired in `index.ts`)

- `whoami()` → own parsed identity.
- `list_peers({ scope?: 'epic' | 'all' })` → reachable peers with role/epic/status/cwd/shortId.
- `send_message({ to, text })` → `to` resolves (`address.ts`) to: full/short sessionId, `pm` (PM of my epic), `epic`/`epic:N` (broadcast), or a name substring; ambiguous/unknown returns candidates instead of guessing.

### Design boundaries that matter for your work

- **`Transport` interface in `mailbox.ts` is the seam for the daemon.** `{ send(recipient,msg), poll(own), watch(own,onMessage): stop }`. `handlers.ts`/`index.ts` depend only on this interface — swap the implementation, keep everything else.
- **`handlers.ts` is dependency-injected** (`HandlerDeps { self, channelsHome, sessionsDir, transport, notify, now? }`). That's why it's testable without stdio and why you can repoint discovery/transport cleanly.

---

## Hard-won facts & gotchas (don't relearn these)

- **Node 25 runs `.ts` directly** (native type-stripping). So local imports use explicit `.ts` extensions (`./message.ts`); SDK imports use `.js` specifiers (`@modelcontextprotocol/sdk/server/index.js`). No build step. Constraint: no `enum`/`namespace`/decorators/param-properties (type-stripping only, no transform). No `any`.
- **Teardown:** the mailbox `watch` `setInterval` is **not** `.unref()`'d, so the process does not self-exit on stdin EOF — Claude Code tears it down via **SIGTERM** (handled in `index.ts`: removes beacon, exits). Don't smoke-test with `node src/index.ts <<< ''` (it hangs); background it and `kill -TERM`. Also note `$!` in a wrapped shell may point at a shell wrapper, not the real node child — send SIGTERM to the real pid (`ps`).
- **Atomic writes** everywhere state is shared: write `.tmp` then `renameSync` (mailbox messages and beacons). Readers filter `*.json`, so `.tmp` is never seen mid-write.
- **Was pulled into the styreo monorepo lockfile once** because `pnpm add` walked up to a parent `pnpm-workspace.yaml`. Here there's no parent workspace, so plain `pnpm install` is fine. (The plan/README still mention `--ignore-workspace` — harmless, and unnecessary in this repo.)
- Tests use temp dirs and a `DEAD_PID = 2_000_000_000`. The `EPERM` branch of `isPidAlive` (alive-but-not-ours) is intentionally not unit-tested (no root-owned pid available).

---

## Known open items (from the final review — code is correct, these are deliberate/deferred)

**Trust the code over the plan doc** — during the build, reviews fixed real bugs, but the plan's Task 3 & Task 5 code blocks were left showing the _pre-fix_ versions. The shipped `src/*.ts` is the source of truth.

1. **Important — self-identity is frozen at startup.** `index.ts` resolves `self` once. A session **renamed after** its sessionbus started (exactly the PM case: a session becomes `epic:2345` post-launch) keeps a stale identity — its own `whoami` / outgoing `from` / `resolveTo('pm'|'epic')` are wrong until restart. _Peers still reach it fine_ (`livePeers` re-derives every peer from the fresh registry). **Fix (recommended, do this as part of generalization): re-derive `self` from the registry on each `send_message`/`list_peers`/`whoami` call** instead of caching it. This basically _has_ to be fixed for a rename-heavy, general-purpose tool.
2. **Important (deferred) — final-hop can be at-most-once.** `poll()` archives a message to `consumed/` _before_ `notify` runs; if `notify` rejects, the message is archived + in the delivered set and won't retry (recoverable by hand from `consumed/`). Low probability on local stdio. Fix option: archive **after** `notify` resolves. The daemon design changes this anyway.
3. **Minor — `readBeacons` casts `JSON.parse(...) as Beacon` with no shape guard** (`registry.ts`), unlike `readSessionEntries`'s `isSessionEntry`. A valid-JSON-but-wrong-shape beacon (missing numeric `pid`) would be treated as dead and deleted. Add an `isBeacon` guard.
4. **Minor/deferred:** `delivered` Set is per-instance not per-recipient (non-issue in prod — one instance polls only its own inbox); epic-broadcast `to.value` stores the raw `to` string ("epic" vs "epic:2345") but nothing reads it; `list_peers` re-reads the sessions dir that `livePeers` already read; a couple of test-coverage gaps (`epic:abc`→none; archival-failure redelivery path). None block MVP.

The full per-task findings ledger + implementer/reviewer reports from the build live in the **old** repo at `~/github/styreo/main/.superpowers/sdd/` (`progress.md`, `task-*-report.md`) if you want the detail — they were not moved. Everything load-bearing is summarized above.

---

## Goal 1 — Generalize

Today the epic/pm/worker convention is hardcoded in `identity.ts` (regexes) and `address.ts` (`pm`/`epic` aliases). To make this a general session-to-session bus with grouping as _one_ convention:

- **Keep the generic core intact**: id/name/short-id addressing, `list_peers`, `send_message`, `whoami` are already convention-agnostic.
- **Make labeling pluggable.** Extract name-parsing into a strategy: `parseSessionName(name) -> { role?, group?, tags? }`, configurable (env or a small config file) so "epic" is just the default group key, not a hardcode. A session named `epic:2345` → `{ group: '2345', role: 'pm' }`; a session named `proj:web worker:api` → generic groups/tags. Preserve the current epic regexes as the default strategy for backward compat.
- **Generalize addressing aliases**: `pm`/`epic` become group-scoped conventions. Consider `group`/`group:X` broadcast and a role alias resolved within the caller's group. Keep the "ambiguous → return candidates" behavior.
- **Fix open item #1 (frozen identity) here** — a general tool must tolerate renames.
- Update `README.md` (repo root is empty) with the generalized model + examples.
- Add the missing tests noted above while you're in there.

## Goal 2 — Install globally, properly

- **User-level MCP registration** (loads for every session) in `~/.claude.json`:

  ```json
  {
    "mcpServers": {
      "sessionbus": {
        "command": "node",
        "args": ["/Users/samer/github/samerziade/claude-sessionbus/sessionbus/src/index.ts"]
      }
    }
  }
  ```

- **Launch flag (research preview):** every session needs `--dangerously-load-development-channels server:sessionbus`. Give the owner a shell alias (e.g. `claude-ch`) and, for the styreo workflow, ensure the PM/worker spawn paths (their `implement-issue` flow) pass the flag.
- **Consider packaging as a Claude Code plugin + marketplace** (`/plugin install`, then `--channels plugin:sessionbus@<marketplace>`) — still needs the dev flag until Anthropic-allowlisted, but it's the "proper" distribution shape. See the plugins / plugin-marketplace docs linked from the channels reference.
- **Ergonomics:** a `sessionbus doctor` subcommand (checks `CLAUDE_CODE_SESSION_ID`, that `~/.claude/sessions` is readable, that the beacon dir is writable, prints resolved identity + live peers) would make global setup debuggable. Non-epic sessions loading the server should stay silent until addressed (they already do — `role: none`).
- Decide whether to **flatten** `claude-sessionbus/sessionbus/` → repo root (one less path segment in the config). Optional.

## Goal 3 — Build the daemon transport (the owner explicitly wants to try this)

The MVP uses the file mailbox. The daemon gives real-time push + live presence. **Build it behind the existing `Transport` interface** so the file backend stays as the default/fallback and everything above the interface is unchanged.

**Design (from the original brainstorm, "Approach B"):**

- One long-lived broker process listening on a **unix domain socket** `~/.claude/channels/broker.sock` (no ports/firewall; localhost by construction).
- Each session's sessionbus connects as a client, sends a `register` frame with its identity, and the broker keeps `sessionId -> connection` plus a per-session queue for anyone offline.
- New `SocketTransport implements Transport`:
  - `send(recipient, msg)` → write a framed `{type:'deliver', to:recipient, msg}` to the broker.
  - `watch(own, onMessage)` → the broker pushes delivered messages to this client; call `onMessage` per message; return a stop fn.
  - `poll(own)` → drain any queued-on-connect backlog (or make it a no-op if the broker pushes the backlog on register).
- **Reuse `address.ts` unchanged**: clients resolve `to` → recipient sessionId(s) locally (using the registry) and the broker just routes by sessionId. Presence can come from the broker's live connection table instead of (or in addition to) beacons.
- **Select via factory/env:** `SESSIONBUS_TRANSPORT=file|socket` (default `file`). `index.ts` picks the transport; nothing else changes.
- **The hard part is lifecycle, not routing** (routing is ~100 lines). Budget for: the startup race when many sessions launch at once (lockfile + "bind the socket or connect to whoever won"); crash recovery (client reconnect w/ backoff, broker respawn); a version handshake so a new client can retire an old broker on code change; orphan reconciliation of the connection table against `~/.claude/sessions/`. This is why the MVP shipped the file backend first.
- Suggested wire protocol: newline-delimited JSON frames — `{type:'register', identity}`, `{type:'send', to:[sessionId…], msg}`, `{type:'deliver', msg}`, optionally `{type:'peers'}`/`{type:'peers_result', peers}` if you want the broker to own presence.
- **Note open item #2 improves for free** under a daemon (broker can ack before the client archives), if you route delivery confirmation back.

Recommend: land the socket transport + factory switch with the file backend still default, get two sessions talking over the socket, _then_ harden the lifecycle. Keep the file mailbox as the fallback when the broker isn't running.

---

## Suggested first moves for the new session

1. `cd sessionbus && pnpm install && pnpm test` — confirm 47 green on your machine.
2. Read `src/handlers.ts` and `src/index.ts` first (the seams), then `mailbox.ts` (the Transport interface you'll re-implement for the daemon).
3. Do the **frozen-identity fix** (open item #1) — small, and unblocks both generalization and correct global behavior.
4. Pick a goal. If the owner is most excited about the daemon, scaffold `SocketTransport` behind the `Transport` interface with the `SESSIONBUS_TRANSPORT` switch and prove two-session delivery before touching lifecycle.
5. Fill in the empty repo-root `README.md`.
