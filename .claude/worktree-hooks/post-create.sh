#!/usr/bin/env bash
# Runs once after a feature worktree is created, from the main worktree.
# Args: <worktree> <main-worktree> <name> <worktrees-dir>
#
# The workspace has no build step and no services, so a worktree needs only its
# dependencies installed. --frozen-lockfile keeps a worktree on exactly the versions
# the lockfile pins rather than silently resolving new ones.
set -euo pipefail

WT="$1"

cd "$WT"
pnpm install --frozen-lockfile
