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

```json
{
  "mcpServers": {
    "sessionbus": { "command": "node", "args": ["/Users/samer/github/styreo/main/tools/sessionbus/src/index.ts"] }
  }
}
```

## Launch (research preview)

Channels require the development flag until allowlisted:

```bash
claude --dangerously-load-development-channels server:sessionbus
```

Suggested shell alias:

```bash
alias claude-ch='claude --dangerously-load-development-channels server:sessionbus'
```

For PM/worker sessions, add the same flag to however those sessions are launched (e.g. the implement-issue spawn path).

## Notes

- Standalone package: installed with `pnpm --ignore-workspace` (its own `pnpm-lock.yaml` + `node_modules`), intentionally NOT part of the styreo pnpm workspace. In a future dedicated repo the `--ignore-workspace` flag is unnecessary.
- Config roots are overridable via env for testing: `SESSIONS_DIR` (default `~/.claude/sessions`) and `CHANNELS_HOME` (default `~/.claude/channels`).
- The server is torn down by Claude Code via SIGTERM (it does not self-exit on stdin EOF); on teardown it removes its presence beacon.
