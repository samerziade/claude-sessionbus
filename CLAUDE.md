# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repo — the fast, current,
source-of-truth orientation. The full design brief lives in `docs/superpowers/`.

## What this is

`sessionbus` is a **Claude Code channel** — an MCP server, spawned once per Claude session
over stdio, that lets separate Claude Code sessions on the same machine **discover and message
each other**. A session _sends_ by calling a tool; it _receives_ as a `<channel …>` event
injected into its context, which drives a turn even when the session is idle.

Status: complete MVP. **86 tests passing** (69 in `bus`, 17 in `broker`). Nothing is on npm; it
runs locally.

## Layout

The package lives in **`bus/`**. Source is `bus/src/*.ts`, each module paired with a `*.test.ts`:

| Module        | Purpose                                                                            | Purity       |
| ------------- | ---------------------------------------------------------------------------------- | ------------ |
| `message.ts`  | `ChannelMessage` type, sortable id, `<channel>` meta mapping                       | pure         |
| `identity.ts` | parse session title → role/epic/issue                                              | pure         |
| `address.ts`  | resolve a `to` string → recipient sessionId(s)                                     | pure         |
| `registry.ts` | read `~/.claude/sessions/*.json`, presence beacons, pid liveness                   | I/O          |
| `mailbox.ts`  | `Transport` interface + flat-file impl: send/poll/watch                            | I/O          |
| `handlers.ts` | DI tool handlers (`whoami`/`list_peers`/`send_message`) + inbound→notify bridge    | I/O via deps |
| `index.ts`    | `main()`: build real deps, wire the MCP server, connect stdio (glue; no unit test) | I/O          |

## Commands

From the repo root:

```bash
pnpm install                        # two-member workspace: bus + broker
pnpm lint                           # biome check (whole repo) + tsc --noEmit per package — the CI gate
pnpm fmt                            # format + apply safe/unsafe fixes; run this after code changes
```

From a package (`bus/` or `broker/`):

```bash
pnpm test                           # vitest run — 55 tests in bus, 17 in broker
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

## Architecture seams (where change is meant to happen)

- **`Transport` interface in `mailbox.ts`** is the seam for the future daemon. Everything above it
  (`handlers.ts`, `index.ts`) depends only on `{ send, poll, watch }`. Swap the implementation,
  keep the rest.
- **`handlers.ts` is dependency-injected** (`HandlerDeps { self, channelsHome, sessionsDir,
transport, notify, now? }`) — testable without stdio; repoint discovery/transport cleanly.
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

The repo was built brainstorm → plan → subagent-driven TDD, and the specs/plan live in
`docs/superpowers/`. Match that: use the superpowers skills (brainstorming before creative work,
TDD before implementation), keep modules pure where they already are, and add the paired
`*.test.ts` for any new module. When the plan doc and the shipped code disagree, **the code wins**.
