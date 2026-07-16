# sessionbus — setup & operations
#
# Quick start:
#   make setup          install deps, register the MCP server (user scope), start the broker
#   make claude         launch a Claude session with the sessionbus channel loaded
#   make doctor         diagnose the setup
#
# Transport (machine-wide — all sessions must agree):
#   TRANSPORT=socket    (default) real-time delivery via the broker. REQUIRES the broker running.
#   TRANSPORT=file      flat-file mailbox. No broker needed.
#   e.g.  make setup TRANSPORT=file
#
# Note: registering the MCP server is permanent, but loading it as a *channel*
# is a per-launch flag (--dangerously-load-development-channels) that Claude Code
# does not let you persist. Use `make claude`, or `make alias` for a shell alias.

SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT          := $(CURDIR)
BUS_ENTRY     := $(ROOT)/bus/src/index.ts
BROKER_ENTRY  := $(ROOT)/broker/src/index.ts
MCP_NAME      ?= sessionbus
TRANSPORT     ?= socket
CHANNELS_HOME ?= $(HOME)/.claude/channels
BROKER        := CHANNELS_HOME=$(CHANNELS_HOME) node $(BROKER_ENTRY)

# launchd (user LaunchAgent — starts at login, respawns on crash)
LAUNCHD_LABEL ?= com.sessionbus.broker
LAUNCHD_DIR   := $(HOME)/Library/LaunchAgents
LAUNCHD_PLIST := $(LAUNCHD_DIR)/$(LAUNCHD_LABEL).plist
LAUNCHD_TMPL  := $(ROOT)/broker/launchd/broker.plist.template
LAUNCHD_TGT   := gui/$(shell id -u)/$(LAUNCHD_LABEL)
NODE_BIN      := $(shell command -v node)

.PHONY: help install test lint check setup teardown \
        mcp-add mcp-remove mcp-status \
        broker-start broker-stop broker-restart broker-status broker-logs broker-fg \
        launchd-install launchd-uninstall launchd-status launchd-restart \
        claude alias doctor

help: ## Show this help
	@echo "sessionbus — make targets"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "TRANSPORT=$(TRANSPORT)   CHANNELS_HOME=$(CHANNELS_HOME)"
	@echo "(socket mode needs the broker running; file mode does not)"

# ---------------------------------------------------------------- build & test

install: ## Install dependencies (all workspace packages)
	pnpm install

test: ## Run all tests (bus + broker)
	pnpm -r test

lint: ## Typecheck all packages (tsc --noEmit)
	pnpm -r lint

check: lint test ## Typecheck + test everything

# ---------------------------------------------------------------- setup

setup: install mcp-add ## Install deps, register the MCP server, start the broker
	@if [ "$(TRANSPORT)" = "socket" ]; then $(MAKE) --no-print-directory broker-start; fi
	@echo
	@echo "Setup complete (TRANSPORT=$(TRANSPORT))."
	@echo "Start a session with the channel loaded:  make claude"
	@echo "Or add a permanent shell alias:           make alias"

teardown: ## Remove everything: launchd agent, broker, MCP registration
	@if [ -f "$(LAUNCHD_PLIST)" ]; then $(MAKE) --no-print-directory launchd-uninstall; \
	 elif [ "$(TRANSPORT)" = "socket" ]; then $(MAKE) --no-print-directory broker-stop; fi
	@$(MAKE) --no-print-directory mcp-remove

# ---------------------------------------------------------------- MCP server

# `claude mcp add` errors on an existing name and has no --force, so remove first.
mcp-add: ## Register sessionbus as a user-scoped MCP server (idempotent)
	@claude mcp remove $(MCP_NAME) -s user >/dev/null 2>&1 || true
	claude mcp add $(MCP_NAME) -s user -e SESSIONBUS_TRANSPORT=$(TRANSPORT) -- node $(BUS_ENTRY)

mcp-remove: ## Unregister the sessionbus MCP server (user scope)
	@claude mcp remove $(MCP_NAME) -s user 2>/dev/null || echo "$(MCP_NAME): not registered"

mcp-status: ## Show the registered MCP server config
	@claude mcp get $(MCP_NAME) 2>&1 || true

# ---------------------------------------------------------------- broker daemon

broker-start: ## Start the broker daemon in the background
	@$(BROKER) start

broker-stop: ## Stop the broker daemon
	@$(BROKER) stop

broker-restart: ## Restart the broker daemon
	@$(BROKER) restart

broker-status: ## Broker status (running? pid? connected sessions?)
	@$(BROKER) status

broker-fg: ## Run the broker in the foreground (Ctrl-C to stop)
	@$(BROKER) --foreground

broker-logs: ## Tail the broker log
	@tail -f $(CHANNELS_HOME)/broker.log

# ---------------------------------------------------------------- launchd (auto-start at login)

# A user LaunchAgent, not a LaunchDaemon: a LaunchDaemon runs as root at boot
# with HOME=/var/root, so the broker would bind a root-owned socket that your
# (non-root) Claude sessions could never use. The broker must run as you.
launchd-install: ## Install+start the broker as a login agent (auto-start, respawn on crash)
	@test -n "$(NODE_BIN)" || { echo "node not found on PATH"; exit 1; }
	@echo "stopping any manually-started broker first (avoids a bind conflict)..."
	@$(BROKER) stop >/dev/null 2>&1 || true
	@mkdir -p $(LAUNCHD_DIR) $(CHANNELS_HOME)
	@sed -e 's|__LABEL__|$(LAUNCHD_LABEL)|g' \
	     -e 's|__NODE__|$(NODE_BIN)|g' \
	     -e 's|__ENTRY__|$(BROKER_ENTRY)|g' \
	     -e 's|__CHANNELS_HOME__|$(CHANNELS_HOME)|g' \
	     -e 's|__LOG__|$(CHANNELS_HOME)/broker.log|g' \
	     -e 's|__ROOT__|$(ROOT)|g' \
	     $(LAUNCHD_TMPL) > $(LAUNCHD_PLIST)
	@echo "wrote $(LAUNCHD_PLIST)"
	@launchctl bootout $(LAUNCHD_TGT) >/dev/null 2>&1 || true
	@launchctl bootstrap gui/$(shell id -u) $(LAUNCHD_PLIST)
	@launchctl enable $(LAUNCHD_TGT)
	@sleep 1
	@$(MAKE) --no-print-directory broker-status
	@echo "broker will now start automatically at login."

launchd-uninstall: ## Stop + remove the login agent (broker no longer auto-starts)
	@launchctl bootout $(LAUNCHD_TGT) 2>/dev/null || echo "agent not loaded"
	@rm -f $(LAUNCHD_PLIST) && echo "removed $(LAUNCHD_PLIST)"
	@$(BROKER) stop >/dev/null 2>&1 || true
	@echo "broker will no longer start at login."

launchd-status: ## Show launchd agent state + broker status
	@if [ -f "$(LAUNCHD_PLIST)" ]; then echo "plist: $(LAUNCHD_PLIST)"; else echo "plist: (not installed)"; fi
	@launchctl print $(LAUNCHD_TGT) 2>/dev/null \
	  | grep -E '^\s+(state|pid|last exit code|program) ' | sed 's/^/  /' \
	  || echo "  agent not loaded"
	@$(MAKE) --no-print-directory broker-status

launchd-restart: ## Restart the login agent's broker
	@launchctl kickstart -k $(LAUNCHD_TGT) && echo "kickstarted $(LAUNCHD_LABEL)"

# ---------------------------------------------------------------- sessions

claude: ## Launch a Claude session with the sessionbus channel loaded
	claude --dangerously-load-development-channels server:$(MCP_NAME)

alias: ## Print a shell alias for launching Claude with the channel
	@echo "# add to ~/.zshrc:"
	@echo "alias claude-ch='claude --dangerously-load-development-channels server:$(MCP_NAME)'"

# ---------------------------------------------------------------- diagnostics

doctor: ## Diagnose the setup (node, CLI, registration, broker, paths)
	@echo "sessionbus doctor"
	@echo "================="
	@printf "%-16s" "node:";          node --version 2>/dev/null || echo "MISSING"
	@printf "%-16s" "node >= 25:";    node -e 'process.exit(parseInt(process.versions.node,10) >= 25 ? 0 : 1)' 2>/dev/null \
	    && echo "ok (native .ts execution, no build step)" \
	    || echo "FAIL — Node 25+ required (native type-stripping)"
	@printf "%-16s" "pnpm:";          pnpm --version 2>/dev/null || echo "MISSING"
	@printf "%-16s" "claude CLI:";    claude --version 2>/dev/null || echo "MISSING"
	@printf "%-16s" "bus entry:";     [ -f "$(BUS_ENTRY)" ] && echo "ok" || echo "MISSING $(BUS_ENTRY)"
	@printf "%-16s" "broker entry:";  [ -f "$(BROKER_ENTRY)" ] && echo "ok" || echo "MISSING $(BROKER_ENTRY)"
	@printf "%-16s" "channels home:"; mkdir -p "$(CHANNELS_HOME)" 2>/dev/null; \
	    [ -w "$(CHANNELS_HOME)" ] && echo "$(CHANNELS_HOME) (writable)" || echo "NOT WRITABLE: $(CHANNELS_HOME)"
	@printf "%-16s" "mcp registered:"; claude mcp get $(MCP_NAME) >/dev/null 2>&1 \
	    && echo "yes" || echo "no — run 'make mcp-add'"
	@printf "%-16s" "mcp transport:"; claude mcp get $(MCP_NAME) 2>/dev/null | grep -o 'SESSIONBUS_TRANSPORT=[a-z]*' || echo "(unset — defaults to file)"
	@printf "%-16s" "launchd agent:"; if [ -f "$(LAUNCHD_PLIST)" ]; then \
	    launchctl print $(LAUNCHD_TGT) >/dev/null 2>&1 \
	      && echo "installed + loaded ($(LAUNCHD_LABEL)) — starts at login" \
	      || echo "plist present but NOT loaded — run 'make launchd-install'"; \
	  else echo "not installed (optional — 'make launchd-install')"; fi
	@echo "broker:"
	@$(BROKER) status 2>/dev/null | sed 's/^/  /' || echo "  unable to query broker"
	@echo
	@if [ "$(TRANSPORT)" = "socket" ]; then \
	  echo "Reminder: socket mode requires the broker running ('make broker-start')."; \
	  echo "A socket-mode session with no broker buffers outgoing messages and retries."; \
	fi
