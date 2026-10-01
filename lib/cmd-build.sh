# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

cmd_build() {
  local with_images=0 rebuild=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --with-images) with_images=1 ;;
      --rebuild)     rebuild=1 ;;
      *) die "unknown option for build: $1" ;;
    esac
    shift
  done

  seu_resolve_project "$PWD"

  step "Preflight"
  [[ -x "$MSB" ]] || die "msb not found at $MSB"
  docker info >/dev/null 2>&1 || die "host Docker is not reachable -- needed to build the base image"
  if seu_load_github_credentials; then
    ok "GitHub Packages credentials for ${GITHUB_ACTOR:-<unknown>}"
  else
    die "No GitHub Packages credentials. The Maven build resolves devx-repository
    and ui-test-components-repository from GitHub Packages, which requires auth
    even for reads.
    Either export GITHUB_ACTOR and GITHUB_TOKEN, or put them in ~/.m2/settings.xml
    as the project README describes. The token is passed to the build sandbox's
    environment only -- it is never written to disk, and the session sandbox
    never sees it."
  fi
  ok "worktree $PROJECT"

  # ------------------------------------------------------------- 1. base image
  local tag; tag="$(seu_image_tag)"
  if [[ $rebuild -eq 0 ]] && msb image list 2>/dev/null | grep -q "${tag#*:}"; then
    step "Base image"
    ok "$tag already loaded (pass --rebuild to force)"
  else
    step "Building base image $tag"
    # Stage a minimal build context: the vm/ files plus the repo's own mise.toml,
    # so the image toolchain always matches what the Maven build validates.
    local ctx; ctx="$(mktemp -d)"
    [[ "$ctx" == "${TMPDIR:-/tmp}"/* ]] || die "failed to create temp directory: ${ctx}"

    trap 'rm -rf "$ctx"' RETURN
    cp "$SEU_ROOT"/vm/Dockerfile "$SEU_ROOT"/vm/*.sh "$SEU_ROOT"/vm/claude-settings.json "$ctx/"
    cp "$PROJECT/mise.toml" "$ctx/mise.toml"

    # --provenance/--sbom off and a single --platform: buildkit otherwise emits a
    # manifest LIST with an attestation manifest, which is not what `msb load`
    # wants from a `docker save` stream.
    docker build \
      --provenance=false --sbom=false --platform linux/arm64 \
      ${CLAUDE_CODE_VERSION:+--build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION"} \
      -t "$tag" "$ctx" >&2 || die "base image build failed"

    step "Loading the image into microsandbox"
    docker save "$tag" | msb load -t "$tag" >/dev/null || die "msb load failed"
    ok "$tag loaded"
  fi

  # ---------------------------------------------------------------- 2. volumes
  step "Named volumes"
  seu_ensure_volumes

  # --------------------------------------------------------- 3. build sandbox
  # A SEPARATE sandbox, because `msb modify` cannot change a sandbox's network
  # policy: the warm-up needs wide egress, the session must not have it. The two
  # share state only through the named volumes.
  step "Creating the build sandbox (wide network egress)"
  local args=()
  while IFS= read -r a; do args+=("$a"); done < <(seu_volume_args)
  while IFS= read -r a; do args+=("$a"); done < <(seu_source_args)

  msb create -n "$BUILD_SANDBOX" --replace \
    --net-conf "$SEU_ROOT/config/net-build.yaml" \
    --resource-conf "$SEU_ROOT/config/resources.yaml" \
    --root-disk 20G \
    --user seu \
    --shell /bin/bash \
    "${args[@]}" \
    "$tag" >/dev/null || die "could not create $BUILD_SANDBOX"
  ok "$BUILD_SANDBOX created"

  seu_wait_agent "$BUILD_SANDBOX"

  # Make sure the build sandbox is torn down even if the warm-up fails, so its
  # wide-open network never outlives the build.
  # shellcheck disable=SC2064
  trap "seu_teardown_build" EXIT INT TERM

  seu_bootstrap_volume "$BUILD_SANDBOX"

  step "Starting dockerd in the build sandbox"
  STATE_DIR_SAVE="$STATE_DIR"; STATE_DIR="$STATE_DIR/build"; mkdir -p "$STATE_DIR"
  seu_start_dockerd "$BUILD_SANDBOX" || die "dockerd failed to start in the build sandbox"
  STATE_DIR="$STATE_DIR_SAVE"

  # ---------------------------------------------------------------- 4. warm up
  step "Warming caches (this takes a while on the first run)"
  msb exec -u seu "$BUILD_SANDBOX" \
    -e "GITHUB_ACTOR=${GITHUB_ACTOR:-}" \
    -e "GITHUB_TOKEN=${GITHUB_TOKEN}" \
    -e "SEU_WITH_IMAGES=${with_images}" \
    -- bash -lc '/usr/local/bin/warm.sh' \
    || die "warm-up failed -- see the output above"

  # --------------------------------------------------------------- 5. teardown
  seu_teardown_build
  trap - EXIT INT TERM

  # ----------------------------------------------------------------- 6. session
  step "Starting the session sandbox"
  # shellcheck source=/dev/null
  source "$SEU_ROOT/lib/cmd-start.sh"; cmd_start

  step "Build complete"
  info "run 'seu shell' any time; 'seu stop' to suspend, 'seu pull' to get work out"

  # Drop straight into a shell, but only when there is a terminal to attach to --
  # `msb exec -t` has nothing to talk to in a scripted or CI run.
  if [[ -t 0 && -t 1 ]]; then
    # shellcheck source=/dev/null
    source "$SEU_ROOT/lib/cmd-shell.sh"; cmd_shell
  else
    info "no tty; skipping the interactive shell"
  fi
}

seu_teardown_build() {
  local sd="$STATE_DIR"
  STATE_DIR="$STATE_DIR/build"
  seu_stop_dockerd
  STATE_DIR="$sd"
  if seu_sandbox_exists "$BUILD_SANDBOX"; then
    step "Removing the build sandbox"
    msb stop -t 60 "$BUILD_SANDBOX" >/dev/null 2>&1 || msb stop -f "$BUILD_SANDBOX" >/dev/null 2>&1 || true
    msb rm "$BUILD_SANDBOX" >/dev/null 2>&1 || true
    ok "removed (its wide network access is gone with it)"
  fi
}
