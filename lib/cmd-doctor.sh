# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

cmd_doctor() {
  local failed=0

  step "Host"
  [[ "$(uname -s)" == "Darwin" ]] || { warn "not macOS; microsandbox targets macOS"; failed=1; }
  [[ "$(uname -m)" == "arm64" ]]  || { warn "not Apple Silicon; microsandbox does not support Intel"; failed=1; }
  ok "$(sw_vers -productName) $(sw_vers -productVersion) $(uname -m)"

  if [[ -x "$MSB" ]]; then ok "msb $("$MSB" --version 2>/dev/null | awk '{print $2}') at $MSB"
  else warn "msb not found at $MSB -- install microsandbox"; failed=1; fi

  if docker info >/dev/null 2>&1; then ok "host Docker reachable (needed by \`seu build\` only)"
  else warn "host Docker not reachable -- \`seu build\` cannot build the base image"; fi

  step "Project"
  seu_resolve_project "$PWD"
  ok "worktree  $PROJECT"
  ok "slug      $SLUG"
  if [[ -n "${GITDIR:-}" ]]; then ok "git dir   $GITDIR (separate; mounted at the same path in the VM)"
  else info "git dir   in-tree"; fi

  if [[ -n "${GITHUB_TOKEN:-}" ]]; then ok "GITHUB_TOKEN set"
  else info "GITHUB_TOKEN not set (required for \`seu build\`, not for sessions)"; fi

  step "Base image"
  local tag; tag="$(seu_image_tag)"
  if msb image list 2>/dev/null | grep -q "${tag#*:}"; then ok "$tag loaded"
  else info "$tag not loaded yet -- run \`seu build\`"; fi

  step "Sandbox"
  local state; state="$(seu_sandbox_state "$SANDBOX")"
  ok "$SANDBOX: $state"

  if [[ "$state" == "running" ]]; then
    step "Inside the VM"
    seu_exec 60 -u seu "$SANDBOX" -- bash -lc '
      printf "java    %s\n" "$(java -version 2>&1 | head -1)"
      printf "maven   %s\n" "$(mvn -v 2>/dev/null | head -1)"
      printf "node    %s\n" "$(node -v 2>/dev/null)"
      printf "pnpm    %s\n" "$(pnpm -v 2>/dev/null)"
      printf "docker  %s\n" "$(docker info --format "{{.ServerVersion}} / {{.Driver}}" 2>/dev/null || echo "NOT RUNNING")"
      printf "claude  %s\n" "$(claude --version 2>/dev/null || echo "n/a")"
    ' 2>&1 | sed 's/^/    /' >&2 || warn "could not query the VM"
  fi

  return $failed
}
