# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

cmd_shell() {
  seu_resolve_project "$PWD"

  if ! seu_sandbox_running "$SANDBOX"; then
    # shellcheck source=/dev/null
    source "$SEU_ROOT/lib/cmd-start.sh"; cmd_start
  elif ! seu_dockerd_running "$SANDBOX"; then
    step "Restarting dockerd"
    seu_start_dockerd "$SANDBOX" || warn "dockerd is not available in this session"
  fi

  cat >&2 <<BANNER

${c_grn}SEU${c_off}  ${c_bld}${PROJECT_NAME}${c_off}
  ${c_dim}/src    host worktree, READ-ONLY
  /work   your writable clone -- commit here, then run 'seu pull' on the host
  net     egress restricted to profile '${NET_PROFILE}'
  docker  in-VM daemon; test/docker-compose.yml and Testcontainers work${c_off}

BANNER

  exec msb exec -t -u seu -w /work "$SANDBOX" -- /bin/bash --login
}
