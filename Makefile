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

.PHONY: help install test lint check setup teardown \
        mcp-add mcp-remove mcp-status \
        broker-start broker-stop broker-restart broker-status broker-logs broker-fg \
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

teardown: ## Stop the broker and unregister the MCP server
	@if [ "$(TRANSPORT)" = "socket" ]; then $(MAKE) --no-print-directory broker-stop; fi
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
	@echo "broker:"
	@$(BROKER) status 2>/dev/null | sed 's/^/  /' || echo "  unable to query broker"
	@echo
	@if [ "$(TRANSPORT)" = "socket" ]; then \
	  echo "Reminder: socket mode requires the broker running ('make broker-start')."; \
	  echo "A socket-mode session with no broker buffers outgoing messages and retries."; \
	fi
