# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

cmd_stop() {
  seu_resolve_project "$PWD"

  if ! seu_sandbox_running "$SANDBOX"; then
    info "$SANDBOX is not running"
    seu_port_stop_all
    seu_stop_dockerd
    return 0
  fi

  step "Stopping $SANDBOX"
  # Graceful first. agentd is PID 1 here, so this normally completes instantly;
  # the -f fallback exists because a wedged guest otherwise drains forever.
  if msb stop -t 60 "$SANDBOX" >/dev/null 2>&1; then
    ok "stopped"
  else
    warn "graceful stop timed out; forcing"
    msb stop -f "$SANDBOX" >/dev/null 2>&1 || die "could not stop $SANDBOX"
    ok "force-stopped"
  fi

  seu_port_stop_all
  seu_stop_dockerd
  info "/work and all caches persist in the named volumes"
}
