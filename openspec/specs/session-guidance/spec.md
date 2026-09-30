# session-guidance Specification

## Purpose
TBD - created by archiving change peer-wake-guidance. Update Purpose after archive.
## Requirements
### Requirement: sessionbus ships a skill that teaches the wake rule

The repo SHALL ship `skills/sessionbus/SKILL.md` as a valid Claude Code skill. Its frontmatter
SHALL have `name: sessionbus` and a `description` of at most 1024 characters that begins with
`Use when`. The description SHALL name both triggers: receiving a `sessionbus` channel message,
and needing to reach or coordinate with another Claude Code session.

The body SHALL state the wake rule. Only a `send_message` whose `to` names a session wakes that
session. Anything a session posts into a room, including an `@`-mention, wakes nobody. A reply
to a person reaches only that person.

#### Scenario: Frontmatter is well formed

- **WHEN** `skills/sessionbus/SKILL.md` is read
- **THEN** it opens with a `---` frontmatter block containing `name: sessionbus` and a `description` that begins with `Use when` and is at most 1024 characters

#### Scenario: The wake rule is stated

- **WHEN** the skill body is read
- **THEN** it states that only `send_message` addressed to a session wakes it, that a session's room post wakes nobody even with an `@`-mention, and that a reply to a person reaches only that person

### Requirement: The skill teaches addressing, relayed wakes and history

The skill body SHALL cover:

- addressing a peer (short id, name, `pm`, `epic`, or a list) versus a person (their full Matrix
  id, taken from a relayed message's `from_id`);
- answering a relayed wake that asks for work from another session, by replying to the person
  **and** separately calling `send_message` for each peer being involved;
- using `read_history` to catch up on `omitted` messages or another room's discussion, and
  noting that it reaches nobody.

The skill SHALL explain that the MCP instructions' "Mention someone by their name in the room"
describes how a person in a chat client reaches a session, not how a session reaches anyone.

#### Scenario: Handing work to a peer from a relayed wake

- **WHEN** the skill body is read
- **THEN** it instructs a session asked by a person to involve a peer to reply to the person and also call `send_message` with that peer in `to`

#### Scenario: The instruction ambiguity is resolved

- **WHEN** the skill body is read
- **THEN** it says that mentioning someone by name in a room is how a person reaches a session, and does not wake a session when a session does it

#### Scenario: read_history is described as read-only

- **WHEN** the skill body is read
- **THEN** it describes `read_history` as a way to read `omitted` or other rooms' messages and says it notifies nobody

### Requirement: Installing the MCP server installs the shipped skills

The repo's MCP install path (`make mcp-add`, and so `make setup`) SHALL also install every
skill directory under `skills/` that contains a `SKILL.md`. Each skill SHALL be installed as a symbolic link at `<skillsDir>/<name>` with an
absolute target, where `<skillsDir>` defaults to `~/.claude/skills` and can be overridden.
`<skillsDir>` SHALL be created when missing.

Per skill:

| What is at `<skillsDir>/<name>`            | Result                           | Filesystem after          |
| ------------------------------------------ | -------------------------------- | ------------------------- |
| nothing                                    | installed                        | link created              |
| a link to this repo's skill directory      | already installed                | unchanged                 |
| anything else (a directory, a file, or a link elsewhere) | conflict; install fails, naming the path | unchanged |

A conflict SHALL NOT stop the other skills from being checked, and SHALL make the install
command exit non-zero.

#### Scenario: A fresh install links the skill

- **WHEN** `make skills-install SKILLS_DIR=<empty tmp dir>` runs
- **THEN** `<tmp>/sessionbus` is a symlink to the absolute path of the repo's `skills/sessionbus` AND the command exits 0

#### Scenario: A missing skills directory is created

- **WHEN** `make skills-install SKILLS_DIR=<tmp>/does-not-exist` runs
- **THEN** that directory is created and contains the `sessionbus` link

#### Scenario: Installing twice is idempotent

- **WHEN** `make skills-install` runs twice against the same `SKILLS_DIR`
- **THEN** the second run reports the skill as already installed, leaves the link unchanged, and exits 0

#### Scenario: A user's own skill is never overwritten

- **WHEN** `<skillsDir>/sessionbus` is a real directory containing a user file and `make skills-install` runs
- **THEN** the command exits non-zero, names that path, and the directory and its file are unchanged

#### Scenario: A link to somewhere else is never replaced

- **WHEN** `<skillsDir>/sessionbus` is a symlink to another directory and `make skills-install` runs
- **THEN** the command exits non-zero and the symlink still points at that directory

#### Scenario: Registering the MCP server installs the skills

- **WHEN** `make mcp-add` runs
- **THEN** the `skills-install` step runs as part of it

### Requirement: Teardown removes only the links it installed

Uninstalling SHALL remove `<skillsDir>/<name>` for each shipped skill only when it is a symlink
to this repo's skill directory. Anything else at that path SHALL be left unchanged and
reported. Uninstalling SHALL never delete the repo's skill files. `make teardown` SHALL run the
uninstall.

#### Scenario: Our link is removed and the source survives

- **WHEN** `make skills-uninstall` runs after a successful install
- **THEN** `<skillsDir>/sessionbus` no longer exists AND `skills/sessionbus/SKILL.md` in the repo still exists

#### Scenario: Uninstalling when nothing is installed is a no-op

- **WHEN** `make skills-uninstall` runs and `<skillsDir>/sessionbus` does not exist
- **THEN** it exits 0 and changes nothing

#### Scenario: A user's own skill survives uninstall

- **WHEN** `<skillsDir>/sessionbus` is a real directory and `make skills-uninstall` runs
- **THEN** the directory is unchanged

#### Scenario: Install, uninstall, install round-trips

- **WHEN** install, uninstall and install run in sequence against the same `SKILLS_DIR`
- **THEN** the link exists after the first and third steps and is absent after the second

