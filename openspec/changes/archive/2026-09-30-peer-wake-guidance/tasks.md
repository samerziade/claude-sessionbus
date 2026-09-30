## 1. The skill

- [x] 1.1 Baseline (writing-skills RED step): in a fresh session with sessionbus loaded and no skill, give a relayed-wake prompt asking the session to "get B to take the migration", and record whether it calls `send_message` to B or only `@`-names B in its reply
- [x] 1.2 Write `skills/sessionbus/SKILL.md` per design D2: frontmatter (`name: sessionbus`, a `Use when…` description of at most 1024 characters naming both triggers), then the wake rule, addressing, answering a relayed wake, the "mention by name" clarification, `read_history`, and the self-check
- [x] 1.3 Check the file against every content scenario in `specs/session-guidance/spec.md`
- [x] 1.4 Pressure test (writing-skills GREEN step): re-run the 1.1 prompt with the skill installed, confirm the session calls `send_message` with B in `to`, and tighten the skill wording if it does not

## 2. The installer

- [x] 2.1 Add `SKILLS_SRC` / `SKILLS_DIR ?= $(HOME)/.claude/skills` and a `skills-install` target to the `Makefile`: loop over `skills/*/SKILL.md`; per skill, report already-installed when the link resolves to this repo, record a conflict when anything else is there, and otherwise `ln -s` with an absolute target; create `SKILLS_DIR`; exit non-zero if any skill conflicted
- [x] 2.2 Add a `skills-uninstall` target that removes only links resolving to this repo's skill directories and reports anything else it finds
- [x] 2.3 Add `skills-install` as a prerequisite of `mcp-add`, run `skills-uninstall` from `teardown`, and add both targets to `.PHONY`

## 3. Verify the installer (temp dirs only, never the real `~/.claude/skills`)

- [x] 3.1 Fresh install: `T=$(mktemp -d); make skills-install SKILLS_DIR=$T/skills`, then confirm `$T/skills` was created and `readlink $T/skills/sessionbus` is the repo's absolute `skills/sessionbus`
- [x] 3.2 Idempotent: run the same command again and confirm exit 0, an already-installed report, and an unchanged link
- [x] 3.3 Conflict (directory): `mkdir -p $T/c/sessionbus && touch $T/c/sessionbus/mine`, run `make skills-install SKILLS_DIR=$T/c`, and confirm a non-zero exit naming the path and that `mine` is intact
- [x] 3.4 Conflict (foreign link): `ln -s /tmp $T/d/sessionbus`, run the install, and confirm a non-zero exit and that the link still points at `/tmp`
- [x] 3.5 Uninstall: run `make skills-uninstall SKILLS_DIR=$T/skills` and confirm the link is gone and the repo's `SKILL.md` still exists; run it again and confirm exit 0; run it against `$T/c` and confirm the directory survives
- [x] 3.6 Round trip: install, uninstall and install against one `SKILLS_DIR`, and confirm the link is present, absent, then present
- [x] 3.7 Confirm `make -n mcp-add` shows the `skills-install` step

## 4. Verification and docs

- [x] 4.1 Confirm `git diff --stat` touches no file under `bus/src` or `broker/src`
- [x] 4.2 Run `pnpm lint` from the repo root and `pnpm test` in `bus/` and `broker/`, and confirm all pass with unchanged test counts
- [x] 4.3 Run `openspec validate peer-wake-guidance --strict`
- [x] 4.4 Update `README.md`: say that setup and `mcp-add` install the `sessionbus` skill, and document `skills-install` / `skills-uninstall` and `SKILLS_DIR`
- [x] 4.5 Update `CLAUDE.md`: describe the `skills/` directory (shipped to users, distinct from `.claude/skills/`), add `session-guidance` to the capabilities table, and note that the skill is where session-facing usage guidance now lives
