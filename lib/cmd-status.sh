# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

cmd_status() {
  seu_resolve_project "$PWD"

  step "Sandboxes"
  msb ls 2>/dev/null | sed 's/^/    /' >&2 || true

  step "Volumes for $SLUG"
  msb volume list 2>/dev/null | grep -E "NAME|seu-$SLUG" | sed 's/^/    /' >&2 || info "none"

  if seu_sandbox_running "$SANDBOX"; then
    step "Inside $SANDBOX"
    seu_exec 60 -u seu "$SANDBOX" -- bash -lc '
      echo "--- toolchain ---"
      java -version 2>&1 | head -1; mvn -v 2>/dev/null | head -1
      echo "node $(node -v 2>/dev/null)  pnpm $(pnpm -v 2>/dev/null)"
      echo "--- docker ---"
      docker info --format "server {{.ServerVersion}}  driver {{.Driver}}  containers {{.Containers}} running {{.ContainersRunning}}" 2>/dev/null || echo "dockerd NOT running"
      docker ps --format "  {{.Names}}\t{{.Image}}\t{{.Status}}" 2>/dev/null | head -20
      echo "--- disk ---"
      df -h /seu 2>/dev/null | tail -n +2; du -sh /seu/* 2>/dev/null
      echo "--- git ---"
      git -C /work status -sb 2>/dev/null | head -10
    ' 2>&1 | sed 's/^/    /' >&2 || warn "could not query the VM"
  else
    info "$SANDBOX is $(seu_sandbox_state "$SANDBOX")"
  fi
}
