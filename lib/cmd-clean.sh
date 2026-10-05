# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

cmd_clean() {
  local drop_volumes=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --volumes) drop_volumes=1 ;;
      *) die "unknown option for clean: $1" ;;
    esac
    shift
  done

  seu_resolve_project "$PWD"

  local sb
  for sb in "$SANDBOX" "$BUILD_SANDBOX"; do
    if seu_sandbox_exists "$sb"; then
      step "Removing $sb"
      msb stop -t 30 "$sb" >/dev/null 2>&1 || msb stop -f "$sb" >/dev/null 2>&1 || true
      msb rm "$sb" >/dev/null 2>&1 || true
      ok "removed"
    fi
  done
  seu_port_stop_all
  seu_stop_dockerd

  # Normally already gone -- seu_sync_claude_config deletes it the moment the
  # files are in the VM. It only survives a crash between the two, and a stray
  # copy of the OAuth blob is not a thing to leave lying around.
  rm -rf "$STATE_DIR/claude"

  if [[ $drop_volumes -eq 1 ]]; then
    step "Removing named volumes"
    warn "this discards /work, ~/.m2, ~/.cache and every pulled Docker image"
    warn "the next \`seu build\` will re-download everything"
    local name; name="$(vol_name)"
    msb volume rm "$name" >/dev/null 2>&1 && ok "removed $name" || info "$name absent"
  else
    info "named volumes kept -- \`seu start\` reuses them; add --volumes to drop them"
  fi
}
