#!/bin/bash
# Prepare ~/work inside the VM. Runs as the `seu` user, idempotent.
#
# /src is the host worktree, mounted READ-ONLY. We never write there. ~/work is a
# clone of it in the home volume, which persists across sandbox stop/start and
# across the install-sandbox -> session-sandbox handoff.
set -uo pipefail

WORK=/home/seu/work

c_ylw=$'\033[33m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'

# /src is owned by the host uid, which differs from ours; without this git
# refuses to touch it ("detected dubious ownership").
git config --global --add safe.directory '*' 2>/dev/null || true
git config --global init.defaultBranch main 2>/dev/null || true
if [[ -z "$(git config --global user.email 2>/dev/null)" ]]; then
  git config --global user.email "seu@localhost"
  git config --global user.name  "SEU sandbox"
fi

if [[ ! -d /src ]]; then
  echo "${c_ylw}warn${c_off} /src is not mounted; $WORK will be empty" >&2
  exit 0
fi

if [[ -n "$(ls -A "$WORK" 2>/dev/null)" ]]; then
  echo "${c_dim}$WORK already populated; leaving it alone${c_off}" >&2
  exit 0
fi

if [[ -f /src/.git ]] && ! git -C /src rev-parse --git-dir >/dev/null 2>&1; then
  # /src/.git is a *file* pointing at a shared git dir that did not come along.
  # Fail loudly: degrading to a history-less copy is how you lose work, because
  # `seu pull` would then have nothing to bundle.
  echo "${c_red}error${c_off} /src has a git pointer file, but its target is not mounted:" >&2
  sed 's/^/    /' /src/.git >&2
  echo "    Re-create the sandbox:  seu clean && seu start" >&2
  exit 1
fi

if ! git -C /src rev-parse --git-dir >/dev/null 2>&1; then
  echo "${c_red}error${c_off} /src is not a git repository" >&2
  exit 1
fi

echo "${c_dim}cloning /src -> $WORK ...${c_off}" >&2
# --no-hardlinks: hardlinks into a read-only virtiofs mount are a trap.
git clone --no-hardlinks /src "$WORK" 2>&1 | sed 's/^/    /' >&2 || exit 1

# Carry over uncommitted work so the sandbox sees what you actually have.
if ! git -C /src diff --quiet HEAD 2>/dev/null; then
  echo "${c_dim}applying uncommitted changes from /src${c_off}" >&2
  git -C /src diff HEAD | git -C "$WORK" apply --index - 2>/dev/null \
    || echo "${c_ylw}warn${c_off} could not apply all uncommitted changes" >&2
fi
