# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

cmd_start() {
  seu_resolve_project "$PWD"

  local netconf; netconf="$(seu_net_conf)"
  [[ -f "$netconf" ]] || die "no such network profile: $netconf"

  if seu_sandbox_running "$SANDBOX"; then
    info "$SANDBOX already running"
  elif seu_sandbox_exists "$SANDBOX"; then
    step "Starting $SANDBOX"
    msb start "$SANDBOX" >/dev/null || die "could not start $SANDBOX"
    ok "started"
  else
    local tag; tag="$(seu_image_tag)"
    seu_image_loaded "$tag" \
      || die "base image $tag is not loaded -- run \`seu build\` first"

    step "Creating $SANDBOX (network profile: $NET_PROFILE)"
    seu_ensure_volumes

    local args=()
    while IFS= read -r a; do args+=("$a"); done < <(seu_volume_args)
    while IFS= read -r a; do args+=("$a"); done < <(seu_source_args)

    msb create -n "$SANDBOX" --replace \
      --net-conf "$netconf" \
      --resource-conf "$SEU_ROOT/config/resources.yaml" \
      --root-disk 20G \
      --user seu \
      --shell /bin/bash \
      "${args[@]}" \
      "$tag" >/dev/null || die "could not create $SANDBOX"
    ok "created"
  fi

  seu_wait_agent "$SANDBOX"

  seu_bootstrap_volume "$SANDBOX"

  step "Starting dockerd"
  seu_start_dockerd "$SANDBOX" || die "dockerd failed to start"

  step "Preparing /work"
  seu_exec 900 -u seu "$SANDBOX" -- bash -lc '/usr/local/bin/session-init.sh' \
    || warn "session-init reported a problem"
}
