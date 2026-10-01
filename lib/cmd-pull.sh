# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

cmd_pull() {
  seu_resolve_project "$PWD"
  seu_sandbox_running "$SANDBOX" || die "$SANDBOX is not running -- \`seu start\` first"

  # A git bundle carries real git objects out over msb's file-copy channel: no
  # network path, no SSH keys, and no writable host mount.
  local bundle="$STATE_DIR/$SLUG.bundle"

  step "Bundling /work"
  seu_exec 300 -u seu "$SANDBOX" -- bash -lc '
    cd /work || exit 1
    git bundle create /tmp/seu.bundle --all 2>&1 | sed "s/^/    /"
  ' >&2 || die "could not create the bundle (is there at least one commit in /work?)"

  msb copy "$SANDBOX:/tmp/seu.bundle" "$bundle" >/dev/null \
    || die "could not copy the bundle out"
  ok "$bundle"

  # Worktrees of one repository share a ref namespace, so a fixed remote name
  # would make two worktrees overwrite each other's fetched refs.
  local remote="${SEU_REMOTE:-seu-$PROJECT_NAME}"

  step "Wiring up remote '$remote'"
  if git -C "$PROJECT" remote get-url "$remote" >/dev/null 2>&1; then
    git -C "$PROJECT" remote set-url "$remote" "$bundle"
  else
    git -C "$PROJECT" remote add "$remote" "$bundle"
  fi
  git -C "$PROJECT" fetch "$remote" >&2 || die "git fetch from the bundle failed"

  step "Review before merging"
  cat >&2 <<REVIEW
    git -C "$PROJECT" log --oneline HEAD..$remote/\$BRANCH
    git -C "$PROJECT" diff HEAD...$remote/\$BRANCH
    git -C "$PROJECT" merge --no-ff $remote/\$BRANCH
REVIEW
  git -C "$PROJECT" branch -r --list "$remote/*" 2>/dev/null | sed 's/^/    /' >&2 || true
}
