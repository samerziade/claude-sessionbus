SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT          := $(CURDIR)
BUS_ENTRY     := $(ROOT)/bus/src/index.ts
BROKER_ENTRY  := $(ROOT)/broker/src/index.ts
MCP_NAME      ?= sessionbus
TRANSPORT     ?= socket
CHANNELS_HOME ?= $(HOME)/.claude/channels
BROKER        := CHANNELS_HOME=$(CHANNELS_HOME) node $(BROKER_ENTRY)

LAUNCHD_LABEL ?= com.ai.sessionbus.broker
LAUNCHD_DIR   := $(HOME)/Library/LaunchAgents
LAUNCHD_PLIST := $(LAUNCHD_DIR)/$(LAUNCHD_LABEL).plist
LAUNCHD_TMPL  := $(ROOT)/ai/launchd/broker.plist.template
LAUNCHD_TGT   := gui/$(shell id -u)/$(LAUNCHD_LABEL)
NODE_BIN      := $(shell command -v node)

.PHONY: setup teardown \
        mcp-add mcp-remove mcp-status \
        launchd-install launchd-uninstall launchd-status launchd-restart \
        claude alias

setup: install mcp-add
	@if [ "$(TRANSPORT)" = "socket" ]; then $(MAKE) --no-print-directory broker-start; fi
	@echo
	@echo "Setup complete (TRANSPORT=$(TRANSPORT))."
	@echo "Start a session with the channel loaded:  make claude"
	@echo "Or add a permanent shell alias:           make alias"

teardown:
	@if [ -f "$(LAUNCHD_PLIST)" ]; then $(MAKE) --no-print-directory launchd-uninstall; \
	 elif [ "$(TRANSPORT)" = "socket" ]; then $(MAKE) --no-print-directory broker-stop; fi
	@$(MAKE) --no-print-directory mcp-remove

# ---------------------------------------------------------------- MCP server

mcp-add: mcp-remove
	claude mcp add $(MCP_NAME) -s user -e SESSIONBUS_TRANSPORT=$(TRANSPORT) -- node $(BUS_ENTRY)

mcp-remove:
	@claude mcp remove $(MCP_NAME) -s user 2>/dev/null || echo "$(MCP_NAME): not registered"

mcp-status:
	@claude mcp get $(MCP_NAME) 2>&1 || true

# ---------------------------------------------------------------- launchd (auto-start at login)

launchd-install:
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
	@$(MAKE) --no-print-directory broker-status

launchd-restart:
	@launchctl kickstart -k $(LAUNCHD_TGT) && echo "kickstarted $(LAUNCHD_LABEL)"

# ---------------------------------------------------------------- sessions

claude: ## Launch a Claude session with the sessionbus channel loaded
	claude --dangerously-load-development-channels server:$(MCP_NAME)

alias: ## Print a shell alias for launching Claude with the channel
	@echo "# add to ~/.zshrc:"
	@echo "alias claude-ch='claude --dangerously-load-development-channels server:$(MCP_NAME)'"
