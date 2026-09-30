# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repo — the fast, current,
source-of-truth orientation. The full design brief lives in `docs/superpowers/`.

## What this is

`sessionbus` is a **Claude Code channel** — an MCP server, spawned once per Claude session
over stdio, that lets separate Claude Code sessions on the same machine **discover and message
each other**. A session _sends_ by calling a tool; it _receives_ as a `<channel …>` event
injected into its context, which drives a turn even when the session is idle.

Status: complete MVP. **717 tests passing** (175 in `bus`, 542 in `broker`). Nothing is on npm; it
runs locally.

## Layout

The package lives in **`bus/`**. Source is `bus/src/*.ts`, each module paired with a `*.test.ts`:

| Module        | Purpose                                                                            | Purity       |
| ------------- | ---------------------------------------------------------------------------------- | ------------ |
| `message.ts`  | `ChannelMessage` (+ `thread` selector, `relay` context), sortable id, `<channel>` meta | pure      |
| `identity.ts` | parse session title → role/epic/issue                                              | pure         |
| `address.ts`  | resolve a `to` string — or a list of them — → recipient sessionId(s)               | pure         |
| `registry.ts` | read `~/.claude/sessions/*.json`, presence beacons, pid liveness                   | I/O          |
| `mailbox.ts`  | `Transport` interface + flat-file impl: send/poll/watch/rekey/history/reply        | I/O          |
| `handlers.ts` | DI tool handlers (`whoami`/`list_peers`/`send_message`/`read_history`) + inbound→notify bridge | I/O via deps |
| `index.ts`    | `main()`: build real deps, wire the MCP server, connect stdio (glue; no unit test) | I/O          |

The broker daemon lives in **`broker/`**, on the same rule — `broker/src/*.ts`, each module
paired with a `*.test.ts`:

| Module                  | Purpose                                                                              | Purity       |
| ----------------------- | ------------------------------------------------------------------------------------ | ------------ |
| `protocol.ts`           | frame types (`RegisterFrame` carries optional `project`/`projectName`/`title`), codec, decoder | pure |
| `config.ts`             | layered defaults → file → env resolution, severity-tagged problems, `config` report   | pure         |
| `matrix-names.ts`       | project + work identity → user / room / space identifier; `slug`, `projectFromRemote` | pure         |
| `fatal.ts`              | fail-loud guard: one non-zero exit per unrecoverable error                            | pure-ish     |
| `broker.ts`             | routing core: conns, queues, identity maps, `onRegistered`/`onRouted` hooks           | in-memory    |
| `bridge-state.ts`       | `BridgeState` seam: sync token, cursors, thread handles; atomic write, tolerant read  | I/O          |
| `matrix-client.ts`      | homeserver calls over an **injected `fetch`**; typed outcomes, never throws           | I/O via deps |
| `matrix-provisioner.ts` | idempotent `ensureUser`/`ensureSpace`/`ensureRoom`/`ensureMember` + bridge-user gate  | I/O via deps |
| `matrix-mirror.ts`      | outbound mirror: id dedupe, room + thread selection, per-room queue with backoff      | I/O via deps |
| `matrix-relay-filter.ts` | the inbound chain: namespace drop, bounded id dedupe, text-only, no self-wake        | pure         |
| `matrix-window.ts`      | unread window selection under both caps + the rendered transcript                     | pure         |
| `matrix-invites.ts`     | `decideInvite` (pure) + operator-only join/decline with idempotent retry               | I/O via deps |
| `matrix-relay.ts`       | inbound relay: one masqueraded sync loop, fan-out through `route()`, cursors, catch-up, replies | I/O via deps |
| `matrix-history.ts`     | `read_history` against the homeserver: room resolution, paging, `search`, `not_found`  | I/O via deps |
| `server.ts`             | unix-socket listener, frame dispatch, stale-socket reclaim                            | I/O          |
| `daemon.ts`             | pid file, start/stop/status, log path                                                 | I/O          |
| `index.ts`              | `main()`: resolve config, wire the fatal guard, serve or dispatch a subcommand (glue) | I/O          |

`broker/src/config.ts` (+ `config.test.ts`) is the third pure seam, alongside `mailbox.ts`'s
`Transport` and `handlers.ts`'s `HandlerDeps`: `resolveConfig`/`formatConfigReport`/
`resolveMatrixToken` take every input as a parameter and touch no `fs`, `child_process` or
`process.env`. `bus/src/index.ts` imports it across the package boundary
(`../../broker/src/config.ts`) — the second instance of the pattern `broker/src/daemon.ts`
already uses to import `bus/src/registry.ts`, and the point of it: both halves must resolve the
same transport and socket path or delivery breaks silently.

### Shipped skills (`skills/`)

`skills/<name>/SKILL.md` holds guidance **shipped to users**. `make mcp-add` links each one into
`~/.claude/skills/`, so every session on the machine loads it. `.claude/skills/` is different:
it holds this repo's own contributor skills (the OpenSpec ones), and those are never installed.

This is where session-facing usage guidance lives. When sessions misuse the bus but the code is
behaving correctly, fix it in the skill rather than in `bus/src` or `broker/src`. Test a skill
edit the way `superpowers:writing-skills` prescribes: run a scenario with and without the skill,
and read every run. The rule the `sessionbus` skill exists to teach is that only `send_message`
with a session in `to` wakes that session. A session's room post wakes nobody, `@`-mention or
not.

## Specs (`openspec/`)

`openspec/specs/` is the **normative requirements baseline** — what the system SHALL do, written
as requirements with WHEN/THEN scenarios. Five capabilities exist today:

| Capability             | Covers                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| `session-discovery`    | identity from session title, own-identity resolution, tolerant registry read, presence beacons + pid liveness, `whoami`, `list_peers` |
| `session-messaging`    | message schema + sortable id, channel meta mapping, to-address resolution, atomic mailbox transport, poll/watch delivery, `send_message`, broadcast fan-out, inbound channel event |
| `broker-lifecycle`     | socket bind and stale-socket reclaim, fail-loud on unrecoverable errors (including a fatal config problem), clean deliberate shutdown, client-failure isolation |
| `broker-configuration` | layered defaults → file → environment resolution, severity-tagged problems, secret resolution via `tokenCommand`, the `broker config` report, shared transport selection |
| `session-grouping`     | deterministic identifiers, project derivation, idempotent provisioning of users/spaces/rooms, bridge-user membership, a session's remote title, durable grouping state |

Two Matrix-bridge changes are in flight under `openspec/changes/` — `matrix-mirror` and
`matrix-relay` — with `docs/superpowers/specs/2026-09-22-sessionbus-matrix-bridge-design.md`
as their rationale. `peer-wake-guidance` adds a sixth capability, `session-guidance`, covering
the shipped `sessionbus` skill and how it is installed alongside the MCP registration.

**Read the relevant spec before answering a question about how the system behaves, and before
proposing a change to it.** Grep or open `openspec/specs/<capability>/spec.md` — the requirement
bodies are the contract, and the capability names alone do not tell you whether behavior is
already specified. Use `openspec list --specs` to enumerate them.

When proposing, reuse an existing capability name if the behavior belongs to it; only mint a new
capability for genuinely new surface area. Additive constraints for the OpenSpec artifact
generators live in `openspec/config.yaml` (`context` + per-artifact `rules`).

`openspec/changes/` holds in-flight and archived change proposals. Archived changes are history;
the baseline in `openspec/specs/` is what currently holds.

## Commands

From the repo root:

```bash
pnpm install                        # two-member workspace: bus + broker
pnpm lint                           # biome check (whole repo) + tsc --noEmit per package — the CI gate
pnpm fmt                            # format + apply safe/unsafe fixes; run this after code changes
```

From a package (`bus/` or `broker/`):

```bash
pnpm test                           # vitest run — 82 tests in bus, 116 in broker
pnpm start                          # node src/index.ts (see teardown note before smoke-testing)
```

Two `bus` tests wait ~1.3s on the mailbox poll interval — that is expected, not a hang.

Node 25 runs `.ts` directly (native type-stripping) — **no build step**. Local imports use
explicit `.ts` extensions (`./message.ts`); SDK imports use `.js` specifiers
(`@modelcontextprotocol/sdk/server/index.js`).

## Configs

Current, verified state:

- **`bus/tsconfig.json`** and **`broker/tsconfig.json`** are NodeNext + `allowImportingTsExtensions`
  + `types: ["node"]` + strict + noEmit. Plain `pnpm exec tsc --noEmit` (run from either package)
  is clean — no hand-passed flags needed.
- **`pnpm-workspace.yaml`** (repo root) globs `bus` and `broker`, so the repo is a coherent
  two-member workspace. A plain `pnpm install` from the root or from either package works.
- **`biome.json`** (repo root) holds the formatter and linter config for the whole repo — there is
  no CSS or JSX here, so it covers TypeScript and JSON only. `pnpm exec biome check` is clean.
- **`~/.claude/sessionbus/config.json`** is the shared runtime config file, read by both
  entrypoints through `loadConfig` in `broker/src/config.ts`. Precedence is built-in defaults →
  file → environment, and the environment layer is deliberately two variables wide
  (`CHANNELS_HOME`, `SESSIONBUS_TRANSPORT`); every other field is file-only. A missing file is the
  normal unconfigured state; an unreadable or corrupt one is a `warning` and falls back to
  defaults. The built-in `transport` default stays `file`; `make config-seed` (a prerequisite of
  `mcp-add` and `setup`) merges `transport: "socket"` into the file, which is why the MCP
  registration no longer passes `-e SESSIONBUS_TRANSPORT`. Problems are returned as data tagged
  `warning` (log it), `invalid` (the Matrix bridge is disabled, carrying a `disabledReason`) or
  `fatal` (unusable `channelsHome` — the serving broker exits non-zero through the existing fatal
  guard, before binding). `broker config` prints the resolved values with each leaf's source
  (`default`/`file`/`env`) and every problem, and always exits 0 — it is the tool that explains
  the very failure that stopped the broker. The launchd plist still carries only `CHANNELS_HOME`;
  keep it that way.

## Constraints (Node 25 native type-stripping)

- No `enum` / `namespace` / decorators / parameter-properties (type-stripping only, no transform).
- Shared on-disk state is written atomically: write `.tmp`, then `renameSync`. Readers filter
  `*.json`, so a partial write is never observed.

## TypeScript conventions

Rules marked **[biome]** fail `pnpm lint`. The rest are **[prose]** — the linter cannot express
them, so they hold by review.

- **[biome] No `any`.** Use `unknown` and narrow with a type guard, or write the precise type.
  Enforced by `suspicious/noExplicitAny`.
- **[prose] No unsafe casts.** `as unknown as X` and `<any>` are banned too — a cast that launders
  a type past the checker is the same defect as `any`, and Biome cannot see it. Derive or narrow to
  the real type instead. A genuinely unavoidable cast at a runtime boundary is permitted **only**
  with an adjacent comment saying why:

  ```ts
  // unavoidable-cast: node's net.Socket exposes no typed handle for this
  ```

- **[biome] `interface` for object shapes, `type` for unions, intersections, and other
  non-object aliases.** `protocol.ts` is the worked example: each frame is an `interface`, the
  `Frame` union is a `type`. Enforced by `style/useConsistentTypeDefinitions`.
- **[biome] Coerce explicitly.** `Boolean(x)`, not `!!x`; `Number(x)`, not `+x`. Identical at
  runtime, but explicit reads clearly and greps. Enforced by `complexity/noImplicitCoercions`.
- **[prose] Reuse canonical types; never re-derive.** A shared type has exactly one home and is
  imported from there. `protocol.ts` imports `ChannelMessage` from `bus` rather than restating its
  shape — restating it would let the wire format drift from the message it carries. If a type has
  no exported alias yet, add one at its canonical home rather than deriving a private copy.
- **[prose] No large inline object types in signatures.** Declare a named `interface` next to the
  consuming code.

### Module state: factory + singleton

Shared mutable state lives in a closure returned by a `createX()` factory — never a module-level
`let`. Vitest does not reset module state between cases, so a module-level `let` leaks one test's
leftovers into the next.

`createFrameDecoder()` in `broker/src/protocol.ts` is the pattern: it owns a `buffer` that must
survive between calls, so the factory returns a decoder closure and each test constructs its own.
Where production needs one shared instance, export the factory *and* a singleton built from it
(`export const x = createX()`); production reads the singleton, tests call the factory.

Do **not** reach for `__resetForTests` exports, env-gated branches inside production code, or
`vi.resetModules()`. Those are the workarounds this pattern exists to avoid.

## Testing conventions

Every module gets a paired `*.test.ts`. Structure: `describe` per function/module under test,
test names describing behavior rather than implementation, and early-return type narrowing
(`if (!result.ok) return` after asserting `result.ok`).

Cover four categories in each test file:

1. **Happy path** — the primary use case and its important variations.
2. **Negative scenarios** — invalid or disallowed input: missing fields, unknown recipients,
   violated preconditions.
3. **Edge cases** — boundary and unusual-but-valid input: empty collections, exactly-at-limit
   values, optional fields omitted vs. explicitly set, single vs. multi-item lists.
4. **Blind spots** — what is easy to overlook: partial writes never observed, order-dependence,
   idempotency, a payload matching its declared shape.

Edge cases and blind spots are scoped **per function** — ask "what could go wrong with _this_
function?" rather than working a generic checklist. The goal is catching real bugs, not inflating
the test count.

## Dependency management

Versions in `package.json` are exact — no `^` or `~`. `.npmrc` sets `save-exact=true`, so future
`pnpm add` calls stay exact without anyone remembering `-E`.

## Teardown gotcha

The mailbox `watch` `setInterval` is **not** `.unref()`'d (the beacon-refresh interval is), so the
process does **not** self-exit on stdin EOF — Claude Code tears it down via **SIGTERM** (`index.ts`
removes the presence beacon and exits). Don't smoke-test with `node src/index.ts <<< ''` — it hangs.
Background it and `kill -TERM`, and send the signal to the _real_ node pid (`$!` in a wrapped shell
may point at a shell wrapper).

## Broker lifecycle: fail loud under launchd

The broker runs as a launchd agent whose only restart trigger is a **non-zero exit**
(`KeepAlive` → `SuccessfulExit=false`), so the broker must actually exit when it fails.
`broker/src/fatal.ts` (`createFatalGuard` + `wireFatalHandlers`) turns any unrecoverable
runtime error — a post-listen listener `error`, an uncaught exception, an unhandled
rejection — into a **single** non-zero exit; `server.ts` routes its post-listen error
through `handleServerError`, and `index.ts` wires the guard onto the process. A
caught-and-swallowed error is the failure this prevents: it strands a live-but-dead
process launchd never restarts. Deliberate shutdown (`SIGTERM`/`SIGINT`/`stop`) stays a
clean `exit(0)` so the agent leaves it stopped rather than fighting the operator.
Exit-driven `KeepAlive` still cannot see a *hung* (non-exiting) broker — a watchdog for
that is deferred. Normative contract: the `broker-lifecycle` capability (change
`broker-fail-loud`; archive to promote it into `openspec/specs/`).

## Architecture seams (where change is meant to happen)

- **`Transport` interface in `mailbox.ts`** is the seam for the future daemon. Everything above it
  (`handlers.ts`, `index.ts`) depends only on
  `{ send, poll, watch, rekey, history, replyToHuman }`. Swap the implementation, keep the rest.
  The last two are request/reply against the broker rather than fire-and-forget, and the flat-file
  implementation answers both `{ ok: false, reason: 'unavailable' }` without any I/O — a complete
  and correct implementation for a transport with no bridge.
- **Channel meta is origin-tagged.** Every message carries `origin` (`session` or `human`), and
  `from_id` is a short session id for one and a full Matrix user id for the other, because
  `from_id` has to stay a value a reply's `to` accepts. A relayed wake additionally carries `room`,
  `unread`, `omitted`, `since`, and `thread`/`thread_title`/`mentions` where they apply.
- **`handlers.ts` is dependency-injected** (`HandlerDeps { self, channelsHome, sessionsDir,
transport, notify, now? }`) — testable without stdio; repoint discovery/transport cleanly.
- **`config.ts` is the configuration seam** — `resolveConfig` is pure, the entrypoints are the only
  glue that reads the file and the environment, and `resolveMatrixToken` takes its process runner
  as a dependency, so nothing here needs disk or `process.env` to be tested.
- **`BridgeState` in `bridge-state.ts`** is the durable-store seam, the same shape as `Transport`:
  one interface, one file-backed implementation today. Reads are memory-backed, writes are
  debounced and land atomically, and `flush()` runs on the deliberate-shutdown path only — the
  fatal path stays fast because everything in the store is reconstructible.
- **The injected `fetch` in `matrix-client.ts`** is the only place that talks to the network, so
  every layer above it is testable without a homeserver. `matrix-provisioner.ts` never sees it:
  it takes the `MatrixClient` interface, plus an injected clock and jitter source, so backoff is
  exact in a test and nothing sleeps.
- **`RegisterFrame` carries optional `project`, `projectName` and `title` at protocol version 1.**
  The additions are deliberately not a version bump: a `bus` that predates the fields binds
  exactly as before, where a bump would make it unreachable rather than merely unprovisioned.
  `broker.ts`'s `onRegistered` hook fires only when a project is present, after binding and after
  the welcome, and always with its own `catch`.
- **A project is `<owner>-<repo>`, shown as `<owner>/<repo>`.** `projectFromRemote` keeps both
  halves of the `origin` remote it parses. The identifier joins them with `-` because `.` is the
  structural separator between an identifier's segments, so a project stays exactly one segment
  however many dashes it holds — which is what keeps truncated and untruncated identifiers
  disjoint. The readable form is the space's **display name**, never its alias: an alias has to
  survive the identifier character rules and a display name has none to survive. Only the session
  can know that form — which dash of `owner-repo` was the owner's cannot be recovered from the
  slug — so it travels as `RegisterMeta.projectName` and reaches `ensureSpace`. A directory with
  no usable remote still falls back to its own name, and a name that slugs to nothing is still no
  project.
- **The bridge never gates binding, and the token command never outlives its deadline.**
  `runForeground` binds the socket, claims the pid file and installs its signal handlers before it
  resolves the token or constructs the bridge; the broker's hooks read the bridge back through a
  late-bound variable, the mirror image of the `serverRef()` the relay reads the broker back
  through. `resolveMatrixToken` is async for the same reason — a synchronous spawn would block the
  event loop of a broker that is already serving — and races the command against a ten-second
  deadline it kills on. Ten seconds is not configurable. `daemon.test.ts` spawns the real
  entrypoint against a helper that never answers and asserts the socket is up *and answering*; the
  answer is the half a bound-but-blocked broker fails.
- Config roots are env-overridable for tests: `SESSIONS_DIR` (default `~/.claude/sessions`),
  `CHANNELS_HOME` (default `~/.claude/channels`).

## Known open items (deliberate/deferred — trust the code, not the plan doc)

1. **Final-hop can be at-most-once (deferred).** `poll()` archives to `consumed/` _before_ `notify`
   runs; if `notify` rejects, the message won't retry (recoverable by hand from `consumed/`). The
   daemon design fixes this for free (ack before archive).
2. **`readBeacons` has no shape guard (minor).** It casts `JSON.parse(...) as Beacon` unlike
   `readSessionEntries`'s `isSessionEntry`. Add an `isBeacon` guard.
3. **Minor:** epic-broadcast `to.value` stores the raw `to` string but nothing reads it; a couple
   of test-coverage gaps (`epic:abc` → none; archival-failure redelivery).
4. **A relayed wake is at-most-once at the channel gate.** The read cursor advances when the wake
   is handed to a live conn. If that session's channel notifications are blocked above the broker,
   the wake is consumed and lost with every layer below reporting success — no layer here can
   observe it. Pre-existing for the local path too; the remedy is the launch flag and a `doctor`
   check, not an acknowledgement protocol.
5. **Only the bot's own invites are handled, and only the operator's are accepted.** An invite
   addressed to a *session* user never appears in the bot's stream, so it stays pending for ever;
   provisioning joins session users to the rooms it creates and leaves no pending invite. An
   operator-gated accept path for session users is deferred until there is a use for it.
6. **The bridge has run against a real homeserver once, and first contact found three things.**
   Two were defects no fake could have caught, and one was a naming decision the operator
   overruled on seeing it in a client; all three are fixed (`first-contact-fixes`). What it cost
   is worth keeping: the token was resolved *before* `startBroker`, so a credential helper waiting
   for an approval a launchd agent can never give left the socket unbound and five sessions unable
   to reach each other. Nothing bounded the wait, either. Hence the two rules now in the code — the
   broker binds before any bridge work begins, and the token command dies after ten seconds. Past
   that, every test still fakes the homeserver, so the composition beyond first contact is proven
   only against a fake; the live checks under "Live verification the tests cannot give" are what
   close that gap.
   A launchd-started broker gets no `PATH` of its own, so `make launchd-install` generates one
   into the plist from where `node` and the token command actually are; without it the bridge
   starts disabled at login while working perfectly by hand. `make config` prints the resolved
   configuration with each field's source when you need to know why the bridge is off.
7. **A `thread` handle still cannot be resolved synchronously on the socket transport.** The
   request/reply frames this change added (`history`, `matrix_reply`) make it possible, but
   `send_message` does not use them for thread resolution, so the staged guarantee in
   `session-grouping` still holds: shape is checked everywhere, and an unresolvable handle mirrors
   to the room's main timeline.

## Identity gotcha: never trust `CLAUDE_CODE_SESSION_ID`

**A session's id is not the id we are launched with.** `claude --resume` mints a throwaway session
id at process launch, exports it to MCP servers as `CLAUDE_CODE_SESSION_ID`, then swaps in the
resumed conversation's real id and rewrites the registry. The env var keeps naming the discarded
id — which has no registry entry and no transcript, and which the session never answers to.

Observed live: six `--resume`d sessions each held an env id (`13cdbad7…`) disjoint from the id
their registry entry published (`f37a1b2c…`). Because beacons were keyed by the env id and
`livePeers` joins registry↔beacons on session id, **the two sets never intersected and
`list_peers` returned `[]` for every session, at every scope.**

The rules that follow:

- **Key identity on `process.ppid`, not the env id.** Our parent is the Claude Code process, and
  registry files are named `<pid>.json`. That pid is stable across the resume swap. `resolveSelf`
  in `identity.ts` does this, keeping the env id only as a fallback for spawn paths where our
  parent is not the session (a shell wrapper).
- **Never cache `self`.** Identity is unsettled at startup — the resume rewrite lands milliseconds
  after we spawn — and a session can be renamed at any time after. `HandlerDeps.self` is a
  `() => PeerIdentity` resolved per call for exactly this reason.
- **The beacon must follow the identity.** `createBeaconKeeper` re-keys and deletes the old file
  when the id changes; a beacon keyed by anything the registry does not publish makes us
  invisible, and a leftover one advertises a session nobody can reach.
- **The beacon and the inbox subscription must always name the same id.** Peers discover us via
  the beacon and address messages there; we only receive what is addressed to the id we
  subscribed with. `index.ts`'s `publish()` moves both together (`beacons.sync` +
  `transport.rekey`) for exactly this reason — never advance one without the other.

**Why that last rule is load-bearing:** healing the beacon *alone* is worse than not healing it.
Both wrong-but-equal means peers cannot see us and nothing is sent. Beacon healed + subscription
frozen means peers see us, `send_message` returns `ok: true`, and the broker silently queues the
message under an id nobody holds (`route()` queues unknown recipients — no log, no error). The
sender is told it worked and the message is never delivered. That failure has been shipped once
already; the paired `rekey` tests in `mailbox.test.ts` / `socket-transport.test.ts` and the
re-registration tests in `broker.test.ts` exist to keep it dead.

## The mission (what the owner wants next)

In priority order:

1. **Generalize** — today identity is hardcoded to the `pm`/`worker`/`epic` convention
   (`identity.ts` regexes, `address.ts` aliases). Make the core generic session-to-session
   messaging with grouping as a _pluggable_ convention; keep the epic regexes as the default
   strategy. Whatever replaces `parseSessionName`, keep resolving *which* entry is ours via
   `resolveSelf`/ppid — see the identity gotcha above.
2. **Install globally, properly** — user-level MCP registration in `~/.claude.json`, an ergonomic
   launch alias, ideally a Claude Code plugin. A `sessionbus doctor` subcommand would help.
3. **Build the daemon transport** — a unix-socket broker behind the existing `Transport` interface,
   selected via `SESSIONBUS_TRANSPORT=file|socket` (default `file`). Land routing + a two-session
   proof first, then harden lifecycle.

## Live verification the tests cannot give (run once, by hand)

No test touches a homeserver: `fetch` is injected everywhere and every relay test drives a
scripted transport. Two behaviours are therefore confirmed only by running them once against the
real homeserver, and are regression checks rather than open questions:

- **A pending invite survives a cold start.** Leave an operator invite to the bot pending, start
  the bridge cold, and confirm the masqueraded initial sync reports it under `rooms.invite` and
  the bot joins.
- **A non-operator invite is declined.** Invite the bot from another local account and confirm it
  leaves the room rather than joining.

Both depend on homeserver behaviour that a fake `fetch` can only assume.

## Markdown conventions (docs in this repo)

When writing or editing any Markdown (`README.md`, `CLAUDE.md`, `docs/**`, etc.):

- **Every fenced code block must have a language specifier.** Never open a bare ` ``` `. Use the
  right language (`bash`, `ts`, `json`, `jsonc`, …); for output, ids, tags, or plain text with no
  better fit, use `text`. This keeps highlighting correct and satisfies markdownlint (MD040).
- **Use Mermaid diagrams, not ASCII art.** For any diagram — architecture, flow, sequence, state —
  write a ` ```mermaid ` block instead of hand-drawn boxes-and-arrows. Mermaid renders on
  GitHub and stays maintainable; ASCII diagrams rot and don't reflow. For example:

  ```mermaid
  flowchart LR
    A[Session A\nsessionbus] -- send_message --> M[(~/.claude/channels\nfile mailbox)]
    M -- watch + deliver --> B[Session B\nsessionbus]
    B -- channel event --> C[Session B context]
  ```

## Working style in this repo

The repo was built brainstorm → plan → subagent-driven TDD, and the original design brief lives in
`docs/superpowers/`. Match that: use the superpowers skills (brainstorming before creative work,
TDD before implementation), keep modules pure where they already are, and add the paired
`*.test.ts` for any new module.

Two different precedence rules apply, and they are not the same:

- **`docs/superpowers/` is historical.** It records what was planned. When it and the shipped code
  disagree, **the code wins** — update or ignore the plan doc.
- **`openspec/specs/` is normative.** It records what the system is required to do. When it and the
  shipped code disagree, **neither silently wins**: say so explicitly, and ask whether the code is a
  bug or the spec has drifted. Do not quietly rewrite the spec to match the code, and do not treat a
  spec mismatch as a proven defect without checking.
