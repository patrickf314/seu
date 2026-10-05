# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

# seu port -- forward host ports into the running VM, docker-style.
#
# Forwards are SSH tunnels against the live sandbox (see seu_port_start in
# common.sh for why), so they can be added and dropped at any time and nothing
# in the VM restarts. They do NOT survive `seu stop`: a tunnel into a stopped
# sandbox has nothing to talk to, and cmd-stop tears them down explicitly.
cmd_port() {
  local specs=() stops=() stop_all=0 arg

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --stop)     shift; [[ $# -gt 0 ]] || die "--stop needs a host port"; stops+=("$1") ;;
      --stop-all) stop_all=1 ;;
      -h|--help)  port_usage ;;
      -*)         die "unknown option for port: $1" ;;
      *)          specs+=("$1") ;;
    esac
    shift
  done

  seu_resolve_project "$PWD"

  if [[ $stop_all -eq 1 ]]; then
    step "Stopping every forward"
    local any=0 line
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      any=1
      info "$(printf '%s' "$line" | awk '{printf "%s:%s -> vm:%s", $1, $2, $3}')"
    done < <(seu_port_list)
    seu_port_stop_all
    [[ $any -eq 1 ]] && ok "stopped" || info "none were active"
    return 0
  fi

  if [[ ${#stops[@]} -gt 0 ]]; then
    step "Stopping forwards"
    for arg in "${stops[@]}"; do
      [[ "$arg" =~ ^[0-9]{1,5}$ ]] || die "--stop takes a host port number, not: $arg"
      if seu_port_up "$arg"; then seu_port_stop "$arg"; ok "host port $arg released"
      else seu_port_stop "$arg"; info "host port $arg was not forwarded"; fi
    done
    return 0
  fi

  # No specs: report. This is the only mode that works on a stopped VM.
  if [[ ${#specs[@]} -eq 0 ]]; then
    step "Forwards for $PROJECT_NAME"
    local found=0 bind host guest pid
    while read -r bind host guest pid; do
      [[ -n "$bind" ]] || continue
      found=1
      printf '    %-21s -> vm:%-5s  pid %s\n' "$bind:$host" "$guest" "$pid" >&2
    done < <(seu_port_list)
    if [[ $found -eq 0 ]]; then
      info "none -- e.g. \`seu port 8080:8080\`"
      seu_sandbox_running "$SANDBOX" || info "$SANDBOX is $(seu_sandbox_state "$SANDBOX")"
    fi
    return 0
  fi

  seu_sandbox_running "$SANDBOX" \
    || die "$SANDBOX is $(seu_sandbox_state "$SANDBOX") -- \`seu start\` first"

  # Parse every spec before starting any, so a typo in the last one does not
  # leave half the forwards up.
  local parsed=() spec
  for spec in "${specs[@]}"; do
    parsed+=("$(seu_port_parse "$spec")")
  done

  seu_ssh_authorize

  step "Forwarding into $SANDBOX"
  local failed=0 bind host guest
  for spec in "${parsed[@]}"; do
    read -r bind host guest <<<"$spec"
    seu_port_start "$bind" "$host" "$guest" || failed=1
  done

  info "forwards live until \`seu port --stop <port>\` or \`seu stop\`"
  [[ $failed -eq 0 ]]
}

port_usage() {
  cat >&2 <<'USAGE'
seu port -- forward host ports into the running VM

usage: seu port [spec...]
       seu port --stop <host-port>
       seu port --stop-all

  seu port                     list the active forwards
  seu port 8080                shorthand for 8080:8080
  seu port 80:80 8080:8080     HOST:GUEST, like docker
  seu port 0.0.0.0:8080:8080   BIND:HOST:GUEST; the default bind is 127.0.0.1,
                               so a forward is not published to your network
                               unless you ask for it

Forwards go over `msb ssh` against the live sandbox, so nothing in the VM
restarts and ports can be added or dropped at any time. They are torn down by
`seu stop` and `seu clean`.
USAGE
  exit 2
}
