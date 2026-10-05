# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

cmd_shell() {
  seu_resolve_project "$PWD"

  if ! seu_sandbox_running "$SANDBOX"; then
    # shellcheck source=/dev/null
    source "$SEU_ROOT/lib/cmd-start.sh"; cmd_start
  else
    if ! seu_dockerd_running "$SANDBOX"; then
      step "Restarting dockerd"
      seu_start_dockerd "$SANDBOX" || warn "dockerd is not available in this session"
    fi
    # cmd_start already did this; re-doing it here is what makes a settings
    # change on the host take effect on the next `seu shell` rather than on the
    # next `seu stop && seu start`. It is three small files, so it is cheap.
    seu_sync_claude_config "$SANDBOX"
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
