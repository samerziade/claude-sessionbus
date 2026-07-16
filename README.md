# sessionbus

A **Claude Code channel** that lets separate Claude Code sessions on the same machine
**discover and message each other**.

It's an MCP server, spawned once per session over stdio. A session _sends_ a message by calling a
tool; the recipient _receives_ it as a `<channel …>` event injected straight into its context —
which drives a turn even when that session was sitting idle. So a worker session can ping its PM
and the PM will actually act on it.

> **Status:** working MVP, 47 tests passing, runs locally. Not published to npm.
> Requires a Claude Code research-preview flag (see [Launch](#launch)).

## How it works

Every Claude session spawns its **own** sessionbus instance; instances never talk to each other
directly. They coordinate entirely through two on-disk mechanisms under `~/.claude/`:

- **Discovery** — Claude Code maintains a live session registry at `~/.claude/sessions/<pid>.json`
  (one file per running session, holding its `sessionId`, `name`/title, `cwd`, `status`).
  sessionbus reads it to find its own identity and enumerate peers, and additionally writes a
  short-lived **presence beacon** so "reachable peer" means _in the registry ∧ beacon present ∧
  process alive_.
- **Transport** — a flat-file **mailbox** under `~/.claude/channels/bus/<recipient>/`, one message
  per file, written atomically. Each server watches its own inbox (`fs.watch` + a ~1s poll
  fallback), delivers new messages as channel events, and archives them.

Identity is parsed from the session **title**:

| Title            | Meaning                                 |
| ---------------- | --------------------------------------- |
| `epic:2345`      | a **PM** for epic 2345                  |
| `1234 epic:2345` | a **worker** on issue 1234 in epic 2345 |
| anything else    | a plain peer (still fully reachable)    |

These are routing hints, not hard rules — sessions with no epic still discover and message each
other. (Making this convention pluggable is on the [roadmap](#roadmap).)

## Tools

Once loaded, a session gets three MCP tools:

- **`whoami()`** — this session's own parsed identity.
- **`list_peers({ scope?: "epic" | "all" })`** — reachable sessions with role/epic/status/cwd.
- **`send_message({ to, text })`** — send to another session. `to` accepts:
  - a full or short session id,
  - a session-name substring,
  - `"pm"` — the PM of your epic,
  - `"epic"` / `"epic:N"` — broadcast to an epic.

  Ambiguous or unknown targets return candidates instead of guessing.

Received messages arrive tagged like:

```text
<channel source="sessionbus" from="1234 epic:2345" from_id="a1b2c3" role="worker" epic="2345" msg_id="…">
  the message text
</channel>
```

Reply by calling `send_message` addressed to the `from_id` in the tag.

## Install

Requires **Node 25+** (it executes TypeScript directly — no build step).

```bash
git clone <this repo>
cd claude-sessionbus/bus
pnpm install --ignore-workspace   # standalone package; see the note below
```

Register it once, for every session, in `~/.claude.json`:

```json
{
  "mcpServers": {
    "sessionbus": {
      "command": "node",
      "args": ["/absolute/path/to/claude-sessionbus/bus/src/index.ts"]
    }
  }
}
```

## Launch

Custom channels are a Claude Code **research preview** and aren't allowlisted yet, so each session
must launch with the development flag:

```bash
claude --dangerously-load-development-channels server:sessionbus
```

A convenient alias:

```bash
alias claude-ch='claude --dangerously-load-development-channels server:sessionbus'
```

Open two sessions this way (give at least one a title like `epic:1`), and they'll see each other
via `list_peers`.

## Development

```bash
cd bus
pnpm install --ignore-workspace
pnpm test                         # vitest — 47 tests
pnpm start                        # run the server on stdio
```

The code is small, dependency-injected, and mostly pure — each `src/*.ts` module has a paired
`*.test.ts`. See [`CLAUDE.md`](CLAUDE.md) for the architecture, the `Transport` seam, and gotchas,
and [`HANDOFF.md`](HANDOFF.md) for the full design brief.

### Heads up: some checked-in configs are stale

This project was extracted from a larger monorepo, and three config files were carried over and
**don't yet match this standalone repo**:

- `bus/tsconfig.json` — a leftover app config; **`pnpm exec tsc --noEmit` currently errors** until
  it's rewritten to the intended NodeNext setup. (Tests are unaffected — vitest transforms
  independently.)
- `pnpm-workspace.yaml` — globs `sessionbus/*`, which no longer matches `bus/`, so a plain root
  `pnpm install` does nothing for the package. That's why installs use `--ignore-workspace`.
- `biome.json` — still contains the old app's overrides.

`CLAUDE.md` documents the exact fixes. Until then, use the commands above verbatim.

## Roadmap

1. **Generalize** — make the `pm`/`worker`/`epic` convention a _pluggable_ labeling strategy so
   sessionbus is a general session-to-session bus with grouping as one default convention.
2. **Global install** — proper user-level registration, an ergonomic launcher, a `doctor`
   subcommand, ideally packaged as a Claude Code plugin.
3. **Daemon transport** — a real-time unix-socket broker behind the existing `Transport` interface
   (selected by `SESSIONBUS_TRANSPORT=file|socket`), with the file mailbox as the fallback.

## License

Not yet specified.

## Broker daemon (real-time transport)

By default sessionbus uses the flat-file mailbox. For real-time delivery, run the **broker
daemon** and switch sessions to socket mode.

The broker is one long-lived process per machine, listening on a unix domain socket
(`~/.claude/channels/broker.sock`). It routes messages by sessionId and holds an in-memory
queue for sessions that are momentarily offline. It is a dumb router — identity resolution
still happens client-side, so `whoami`/`list_peers`/`send_message` behave identically.

### Run the broker

```bash
cd broker
node src/index.ts start      # background daemon (logs to ~/.claude/channels/broker.log)
node src/index.ts status     # running? pid? connected sessions?
node src/index.ts stop
node src/index.ts restart
node src/index.ts             # or --foreground: run in this terminal (Ctrl-C to stop)
```

### Switch sessions to socket mode

Set `SESSIONBUS_TRANSPORT=socket` for every session (e.g. in the user-level MCP registration
`env` block). Unset — or `file` — keeps the file mailbox. All sessions on a machine must agree:
socket-mode sessions only talk to other socket-mode sessions through the broker.

While the broker is down, a socket-mode session buffers outgoing messages and reconnects with
backoff; it does not fall back to the file mailbox. In-memory broker queues are dropped if the
broker itself restarts (durable queues are a planned follow-up).

### Auto-start at login (macOS launchd)

To have the broker always running, install it as a **user LaunchAgent** — it starts at login and
respawns if it crashes:

```bash
make launchd-install      # install + start; auto-starts at login from now on
make launchd-status       # agent state + broker status
make launchd-restart      # kickstart the agent's broker
make launchd-uninstall    # stop + remove; no longer auto-starts
```

`make launchd-install` renders `broker/launchd/broker.plist.template` with absolute paths into
`~/Library/LaunchAgents/com.sessionbus.broker.plist` and bootstraps it. It is idempotent — re-run
it any time (it stops a manually-started broker first to avoid a bind conflict).

Details worth knowing:

- **LaunchAgent, not LaunchDaemon.** A LaunchDaemon runs as root at boot with `HOME=/var/root`,
  so the broker would bind a root-owned socket under `/var/root/.claude/channels` while your
  Claude sessions — running as you — look in `~/.claude/channels`. They would never meet. The
  broker must run as the same user as the sessions it serves.
- **The agent runs `--foreground`,** because launchd supervises the process directly. `broker
  start` detaches and exits, which launchd would read as an immediate crash and respawn-loop.
- **A crash respawns; a deliberate stop does not.** `KeepAlive/SuccessfulExit=false` means
  `make broker-stop` (clean exit) stays stopped rather than being fought by launchd; a real crash
  is respawned after launchd's ~10s throttle. Use `make launchd-restart` to bring it back.
- **The node path is pinned.** The plist stores an absolute path to the `node` binary, so an
  nvm/fnm/homebrew node upgrade will break the agent — re-run `make launchd-install` afterwards.
- Use launchd **or** the manual `broker start`/`stop` targets, not both at once: whichever binds
  the socket first wins, and the other will refuse to start.
