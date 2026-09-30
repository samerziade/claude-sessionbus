SHELL := /bin/bash
.DEFAULT_GOAL := setup

ROOT          := $(CURDIR)
BUS_ENTRY     := $(ROOT)/bus/src/index.ts
BROKER_ENTRY  := $(ROOT)/broker/src/index.ts
MCP_NAME      ?= sessionbus
TRANSPORT     ?= socket
CHANNELS_HOME ?= $(HOME)/.claude/channels
CONFIG_FILE   := $(HOME)/.claude/sessionbus/config.json
BROKER        := CHANNELS_HOME=$(CHANNELS_HOME) node $(BROKER_ENTRY)
SKILLS_SRC    := $(ROOT)/skills
SKILLS_DIR    ?= $(HOME)/.claude/skills

LAUNCHD_LABEL ?= com.ai.sessionbus.broker
LAUNCHD_DIR   := $(HOME)/Library/LaunchAgents
LAUNCHD_PLIST := $(LAUNCHD_DIR)/$(LAUNCHD_LABEL).plist
LAUNCHD_TMPL  := $(ROOT)/broker/launchd/broker.plist.template
LAUNCHD_TGT   := gui/$(shell id -u)/$(LAUNCHD_LABEL)
NODE_BIN      := $(shell command -v node)
# The PATH the launchd agent runs with. launchd supplies none, so a token command living in a
# package manager's bin directory would be unreachable and the bridge would start disabled.
# Derived from where node and the token command actually are on this shell's PATH.
TOKEN_CMD     ?= op
TOKEN_BIN     := $(shell command -v $(TOKEN_CMD))
AGENT_PATH    := $(shell printf '%s\n' "$$(dirname $(NODE_BIN))" "$$(dirname $(TOKEN_BIN) 2>/dev/null)" /usr/bin /bin /usr/sbin /sbin | awk 'NF && !seen[$$0]++' | paste -sd: -)

.PHONY: setup teardown config-seed config \
        mcp-add mcp-remove mcp-status skills-install skills-uninstall \
        launchd-install launchd-uninstall launchd-status launchd-restart \
        claude alias

setup: config-seed mcp-add launchd-install alias

teardown:
	@if [ -f "$(LAUNCHD_PLIST)" ]; then $(MAKE) --no-print-directory launchd-uninstall; \
	 elif [ "$(TRANSPORT)" = "socket" ]; then $(BROKER) stop; fi
	@$(MAKE) --no-print-directory mcp-remove
	@$(MAKE) --no-print-directory skills-uninstall

# ---------------------------------------------------------------- config file

# Seed the shared config file with `transport`, merging into an existing file and never
# overriding a `transport` it already sets. The code's built-in default stays "file"; the
# install gets socket mode from this file, which bus and the broker both read.
config-seed:
	@CONFIG="$(CONFIG_FILE)" SEED_TRANSPORT="$(TRANSPORT)" node -e ' \
	  const fs = require("node:fs"), path = require("node:path"); \
	  const f = process.env.CONFIG; let c = {}; \
	  if (fs.existsSync(f)) { \
	    try { c = JSON.parse(fs.readFileSync(f, "utf8")) } \
	    catch (e) { console.error(f + ": not valid JSON; leaving it alone"); process.exit(1) } \
	    if (typeof c !== "object" || c === null || Array.isArray(c)) { \
	      console.error(f + ": not a JSON object; leaving it alone"); process.exit(1) } \
	  } \
	  if ("transport" in c) { console.log(f + ": transport already set (" + JSON.stringify(c.transport) + ")"); process.exit(0) } \
	  c.transport = process.env.SEED_TRANSPORT; \
	  fs.mkdirSync(path.dirname(f), { recursive: true }); \
	  fs.writeFileSync(f + ".tmp", JSON.stringify(c, null, 2) + "\n"); \
	  fs.renameSync(f + ".tmp", f); \
	  console.log(f + ": seeded transport " + JSON.stringify(c.transport))'

# Print the configuration the broker and bus actually resolved, with each field's source and the
# token redacted. First stop when the bridge is off and you want to know why.
config:
	@$(BROKER) config

# ---------------------------------------------------------------- MCP server

# No -e SESSIONBUS_TRANSPORT: the transport comes from the config file seeded above.
mcp-add: config-seed mcp-remove skills-install
	claude mcp add $(MCP_NAME) -s user -- node $(BUS_ENTRY)

mcp-remove:
	@claude mcp remove $(MCP_NAME) -s user 2>/dev/null || echo "$(MCP_NAME): not registered"

mcp-status:
	@claude mcp get $(MCP_NAME) 2>&1 || true

# ---------------------------------------------------------------- skills (shipped with the MCP server)

# Link every skill under skills/ into the user's skills directory, so registering the server
# also teaches sessions how to use it. A link, not a copy: the guidance tracks this checkout on
# every pull. Anything already at a skill's path that is not our link is left alone, and the
# install fails naming it.
skills-install:
	@mkdir -p "$(SKILLS_DIR)"
	@rc=0; for f in "$(SKILLS_SRC)"/*/SKILL.md; do \
	  [ -f "$$f" ] || continue; \
	  src="$$(dirname "$$f")"; name="$$(basename "$$src")"; dst="$(SKILLS_DIR)/$$name"; \
	  if [ -L "$$dst" ] && [ "$$(readlink "$$dst")" = "$$src" ]; then \
	    echo "$$name: already installed at $$dst"; \
	  elif [ -e "$$dst" ] || [ -L "$$dst" ]; then \
	    echo "$$name: $$dst is in the way (not a link to $$src); leaving it alone" >&2; rc=1; \
	  else \
	    ln -s "$$src" "$$dst" && echo "$$name: linked $$dst -> $$src"; \
	  fi; \
	done; exit $$rc

# Remove only the links skills-install made; anything else at those paths is reported and kept.
skills-uninstall:
	@for f in "$(SKILLS_SRC)"/*/SKILL.md; do \
	  [ -f "$$f" ] || continue; \
	  src="$$(dirname "$$f")"; name="$$(basename "$$src")"; dst="$(SKILLS_DIR)/$$name"; \
	  if [ -L "$$dst" ] && [ "$$(readlink "$$dst")" = "$$src" ]; then \
	    rm "$$dst" && echo "$$name: removed $$dst"; \
	  elif [ -e "$$dst" ] || [ -L "$$dst" ]; then \
	    echo "$$name: $$dst is not a link to $$src; leaving it alone"; \
	  else \
	    echo "$$name: not installed"; \
	  fi; \
	done

# ---------------------------------------------------------------- launchd (auto-start at login)

launchd-install:
	@test -n "$(NODE_BIN)" || { echo "node not found on PATH"; exit 1; }
	@echo "stopping any manually-started broker first (avoids a bind conflict)..."
	@$(BROKER) stop >/dev/null 2>&1 || true
	@test -f $(LAUNCHD_TMPL) || { echo "template not found: $(LAUNCHD_TMPL)"; exit 1; }
	@mkdir -p $(LAUNCHD_DIR) $(CHANNELS_HOME)
	@sed -e 's|__LABEL__|$(LAUNCHD_LABEL)|g' \
	     -e 's|__NODE__|$(NODE_BIN)|g' \
	     -e 's|__ENTRY__|$(BROKER_ENTRY)|g' \
	     -e 's|__CHANNELS_HOME__|$(CHANNELS_HOME)|g' \
	     -e 's|__PATH__|$(AGENT_PATH)|g' \
	     -e 's|__LOG__|$(CHANNELS_HOME)/broker.log|g' \
	     -e 's|__ROOT__|$(ROOT)|g' \
	     $(LAUNCHD_TMPL) > $(LAUNCHD_PLIST).tmp
	@mv $(LAUNCHD_PLIST).tmp $(LAUNCHD_PLIST)
	@echo "wrote $(LAUNCHD_PLIST)"
	@launchctl bootout $(LAUNCHD_TGT) >/dev/null 2>&1 || true
	@launchctl bootstrap gui/$(shell id -u) $(LAUNCHD_PLIST)
	@launchctl enable $(LAUNCHD_TGT)
	@sleep 1
	@$(BROKER) status
	@echo "broker will now start automatically at login."

launchd-uninstall:
	@launchctl bootout $(LAUNCHD_TGT) 2>/dev/null || echo "agent not loaded"
	@rm -f $(LAUNCHD_PLIST) && echo "removed $(LAUNCHD_PLIST)"
	@$(BROKER) stop >/dev/null 2>&1 || true
	@echo "broker will no longer start at login."

launchd-status:
	@if [ -f "$(LAUNCHD_PLIST)" ]; then echo "plist: $(LAUNCHD_PLIST)"; else echo "plist: (not installed)"; fi
	@launchctl print $(LAUNCHD_TGT) 2>/dev/null \
	  | grep -E '^\s+(state|pid|last exit code|program) ' | sed 's/^/  /' \
	  || echo "  agent not loaded"
	@$(BROKER) status

launchd-restart:
	@launchctl kickstart -k $(LAUNCHD_TGT) && echo "kickstarted $(LAUNCHD_LABEL)"

# ---------------------------------------------------------------- sessions

alias:
	@echo "alias claude-ch='claude --dangerously-load-development-channels server:$(MCP_NAME)'"
