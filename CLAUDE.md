# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repo — the fast, current,
source-of-truth orientation. The full design brief lives in `docs/superpowers/`.

## What this is

`sessionbus` is a **Claude Code channel** — an MCP server, spawned once per Claude session
over stdio, that lets separate Claude Code sessions on the same machine **discover and message
each other**. A session _sends_ by calling a tool; it _receives_ as a `<channel …>` event
injected into its context, which drives a turn even when the session is idle.

Status: complete MVP. **47 tests passing.** Nothing is on npm; it runs locally.

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

## Commands (run from `bus/`)

```bash
cd bus
pnpm install                        # workspace is coherent now — no --ignore-workspace needed
pnpm test                           # vitest run — 47 tests; two wait ~1.3s on the mailbox poll interval (expected)
pnpm start                          # node src/index.ts — runs the server on stdio (see teardown note)
```

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
- No `any`.
- Shared on-disk state is written atomically: write `.tmp`, then `renameSync`. Readers filter
  `*.json`, so a partial write is never observed.

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

1. **Frozen self-identity (important).** `index.ts` resolves `self` once at startup. A session
   renamed _after_ its sessionbus started (the PM case) keeps a stale identity — its own `whoami`,
   outgoing `from`, and `resolveTo('pm'|'epic')` are wrong until restart. Peers still reach it fine
   (`livePeers` re-derives every peer from the fresh registry each call). Fix: re-derive `self`
   from the registry on each `send_message`/`list_peers`/`whoami`. Do this as part of Goal 1.
2. **Final-hop can be at-most-once (deferred).** `poll()` archives to `consumed/` _before_ `notify`
   runs; if `notify` rejects, the message won't retry (recoverable by hand from `consumed/`). The
   daemon design fixes this for free (ack before archive).
3. **`readBeacons` has no shape guard (minor).** It casts `JSON.parse(...) as Beacon` unlike
   `readSessionEntries`'s `isSessionEntry`. Add an `isBeacon` guard.
4. **Minor:** epic-broadcast `to.value` stores the raw `to` string but nothing reads it; a couple
   of test-coverage gaps (`epic:abc` → none; archival-failure redelivery).

## The mission (what the owner wants next)

In priority order:

1. **Generalize** — today identity is hardcoded to the `pm`/`worker`/`epic` convention
   (`identity.ts` regexes, `address.ts` aliases). Make the core generic session-to-session
   messaging with grouping as a _pluggable_ convention; keep the epic regexes as the default
   strategy. Fix open item #1 here.
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
