## Why

Sessions talking through the bridge keep posting messages that wake nobody. The bus behaves
correctly: the only thing that wakes a session is a `send_message` addressed to it. A post
authored by a session is room history by design, and a reply to a person mentions that person
only. The sessions were simply never taught this. A session woken by a person answers into the
room, writes "@worker-3 can you take the migration", and assumes the peer heard. It did not.

This is an education problem, not a behaviour problem. The fix is to ship guidance with the
MCP server, so that installing sessionbus also teaches every session how to use it.

## What Changes

- **Ship skills alongside the MCP server.** A new top-level `skills/` directory holds the
  guidance. It starts with one skill, `skills/sessionbus/SKILL.md`, which teaches:
  - the wake rule;
  - how to address a peer versus a person;
  - how to answer a relayed wake while handing work to a peer;
  - when to use `read_history`.

  It also says plainly what "mention someone by name in the room" in the MCP instructions
  means: that is how a *person* in a chat client reaches a session, not how a session reaches
  anyone.
- **Installing the MCP installs the skills.** `make mcp-add` (and so `make setup`) links every
  skill under `skills/` into `~/.claude/skills/`. `make teardown` removes the links. The
  install is a link rather than a copy, so the guidance tracks the repo on every pull. The
  installer never overwrites a skill it did not create.
- **No code changes.** Nothing under `bus/src` or `broker/src` changes, including the MCP
  instruction text. The work is Markdown and Makefile only.

## Capabilities

### New Capabilities

- `session-guidance`: the guidance shipped with sessionbus. It covers what the shipped skill
  must teach, and how the skills are installed and removed alongside the MCP registration.

### Modified Capabilities

None. Messaging, discovery and grouping behaviour is unchanged.

## Impact

- **Seam:** none. No `Transport`, `HandlerDeps` or identity change, so there is no beacon or
  subscription risk.
- **New files:** `skills/sessionbus/SKILL.md`.
- **Changed files:** `Makefile` (new `skills-install` / `skills-uninstall` targets, wired into
  `mcp-add` and `teardown`), `README.md`, `CLAUDE.md`.
- **User machine:** one symlink per shipped skill under `~/.claude/skills/`.
- **Mission fit:** a step toward priority 2 (install globally, properly). The `skills/<name>/`
  layout is what a Claude Code plugin uses, so a later plugin can bundle these skills with the
  MCP registration without moving them.
