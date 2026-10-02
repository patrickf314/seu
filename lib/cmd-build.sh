# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

cmd_build() {
  local with_images=0 rebuild=0 refresh_images=0 use_host_images=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --with-images)     with_images=1 ;;
      --rebuild)         rebuild=1 ;;
      --refresh-images)  refresh_images=1 ;;
      --no-host-images)  use_host_images=0 ;;
      --no-host-m2)      SEU_USE_HOST_M2=0 ;;
      *) die "unknown option for build: $1" ;;
    esac
    shift
  done

  seu_resolve_project "$PWD"

  step "Preflight"
  [[ -x "$MSB" ]] || die "msb not found at $MSB"
  docker info >/dev/null 2>&1 || die "host Docker is not reachable -- needed to build the base image"
  ok "worktree $PROJECT"

  if [[ -f "$SEU_CONF_FILE" ]]; then
    ok "profile  ${SEU_CONF_FILE#$PROJECT/}"
    local unknown; unknown="$(seu_conf_unknown_keys)"
    if [[ -n "$unknown" ]]; then
      warn "unknown keys in $SEU_CONF_FILE: $(printf '%s' "$unknown" | tr '\n' ' ')"
    fi
  else
    info "no .seu/config.conf -- using defaults (no prepulled images, no Maven servers)"
  fi

  # ---------------------------------------------- Maven credentials + settings
  # The generated settings.xml holds ${env.*} placeholders only; the values go
  # into the warm-up process's environment and nowhere else.
  local servers=() env_args=() cred_count=0
  while IFS= read -r a; do servers+=("$a"); done < <(seu_maven_server_args)

  local gen_dir="$STATE_DIR/build"; mkdir -p "$gen_dir"
  local settings="$gen_dir/settings.xml"
  local host_repo=""
  if [[ "${SEU_USE_HOST_M2:-1}" == "1" && -d "$SEU_HOST_M2" ]]; then
    host_repo="$SEU_HOST_M2_MOUNT"
    ok "host Maven repository $SEU_HOST_M2 -- mounted read-only, build sandbox only"
  else
    info "host Maven repository not used; everything will be downloaded"
  fi

  python3 "$SEU_ROOT/lib/maven-settings.py" --emit-settings \
    ${host_repo:+--host-repo "$host_repo"} \
    ${servers[@]+"${servers[@]}"} > "$settings" \
    || die "could not generate the in-VM Maven settings"

  while IFS= read -r kv; do
    [[ -n "$kv" ]] || continue
    env_args+=(-e "$kv")
    case "$kv" in *_PASS=*) cred_count=$((cred_count + 1)) ;; esac
  done < <(python3 "$SEU_ROOT/lib/maven-settings.py" --emit-env \
             ${servers[@]+"${servers[@]}"} 2>/dev/null || true)

  if [[ ${#servers[@]} -gt 0 ]]; then
    if [[ $cred_count -gt 0 ]]; then
      ok "credentials for $cred_count of $(( ${#servers[@]} / 2 )) configured Maven server(s)"
    else
      die "No credentials for the Maven servers this project needs
    ($(seu_conf_all maven_server | tr '\n' ' ')).
    Put them in ~/.m2/settings.xml, or export GITHUB_ACTOR and GITHUB_TOKEN.
    They are passed to the build sandbox's environment only -- never written to
    disk, and the session sandbox never sees them."
    fi
  fi

  # ------------------------------------------------------------- 1. base image
  local tag; tag="$(seu_image_tag)"
  if [[ $rebuild -eq 0 ]] && seu_image_loaded "$tag"; then
    step "Base image"
    ok "$tag already loaded (pass --rebuild to force)"
  else
    step "Building base image $tag"
    # Stage a minimal build context: the vm/ files plus the repo's own mise
    # config, so the image toolchain always matches what the build validates.
    # The `rm -rf` below is why this is checked at all. Do not reinstate a
    # prefix test against $TMPDIR: macOS sets it WITH a trailing slash, so
    # "${TMPDIR}"/* becomes ".../T//*" -- two literal slashes -- and never
    # matches what mktemp returns.
    local ctx; ctx="$(mktemp -d)" || die "could not create a temp directory"
    [[ -n "$ctx" && -d "$ctx" ]] || die "mktemp did not create a directory: ${ctx:-<empty>}"

    trap 'rm -rf "$ctx"' RETURN
    cp "$SEU_ROOT"/vm/Dockerfile "$SEU_ROOT"/vm/*.sh "$SEU_ROOT"/vm/claude-settings.json "$ctx/"
    # mise.toml must exist in the context because the Dockerfile COPYs it; an
    # empty one is a valid "no managed toolchain" answer for a project that has
    # no mise config at all.
    local mise
    if mise="$(seu_mise_config)"; then
      cp "$mise" "$ctx/mise.toml"
      info "toolchain from ${mise#$PROJECT/}"
    else
      : > "$ctx/mise.toml"
      info "no mise config -- the image gets no managed JDK/Maven"
    fi

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

  # ------------------------------------------------------- 3. host Docker images
  step "Staging Docker images from the host"
  if [[ $use_host_images -eq 1 ]]; then
    seu_export_host_images "$refresh_images"
  else
    info "--no-host-images: every image will be pulled inside the VM"
    rm -f "$(seu_host_images_tar)"
  fi

  # --------------------------------------------------------- 4. build sandbox
  # A SEPARATE sandbox, because `msb modify` cannot change a sandbox's network
  # policy: the warm-up needs wide egress, the session must not have it. The two
  # share state only through the named volumes -- which is also why the host
  # mounts added here cannot reach the session.
  step "Creating the build sandbox (wide network egress)"
  local args=()
  while IFS= read -r a; do args+=("$a"); done < <(seu_volume_args)
  while IFS= read -r a; do args+=("$a"); done < <(seu_source_args)
  while IFS= read -r a; do args+=("$a"); done < <(seu_build_mount_args)

  msb create -n "$BUILD_SANDBOX" --replace \
    --net-conf "$SEU_ROOT/config/net-build.yaml" \
    --resource-conf "$SEU_ROOT/config/resources.yaml" \
    --root-disk 20G \
    --user seu \
    --shell /bin/bash \
    --copy-file "$settings:/tmp/seu-settings.xml" \
    "${args[@]}" \
    "$tag" >/dev/null || die "could not create $BUILD_SANDBOX"
  ok "$BUILD_SANDBOX created"

  seu_wait_agent "$BUILD_SANDBOX"

  # Make sure the build sandbox is torn down even if the warm-up fails, so its
  # wide-open network and its host mounts never outlive the build.
  # shellcheck disable=SC2064
  trap "seu_teardown_build" EXIT INT TERM

  # --copy-file happens pre-boot; verify rather than discover it in warm.sh.
  seu_exec 30 -u root "$BUILD_SANDBOX" -- test -s /tmp/seu-settings.xml >/dev/null 2>&1 \
    || msb copy "$settings" "$BUILD_SANDBOX:/tmp/seu-settings.xml" >/dev/null \
    || die "could not place the generated Maven settings in the build sandbox"

  seu_bootstrap_volume "$BUILD_SANDBOX"

  step "Starting dockerd in the build sandbox"
  STATE_DIR_SAVE="$STATE_DIR"; STATE_DIR="$STATE_DIR/build"; mkdir -p "$STATE_DIR"
  seu_start_dockerd "$BUILD_SANDBOX" || die "dockerd failed to start in the build sandbox"
  STATE_DIR="$STATE_DIR_SAVE"

  # ---------------------------------------------------------------- 5. warm up
  step "Warming caches (this takes a while on the first run)"
  local prepull warm_artifacts pw_pom pw_browsers
  prepull="$(seu_conf_all prepull | tr '\n' ' ')"
  warm_artifacts="$(seu_warm_artifacts | tr '\n' ' ')"
  pw_pom="$(seu_playwright_pom || true)"
  pw_browsers="$(seu_playwright_browsers)"
  if [[ -n "$pw_pom" ]]; then
    ok "playwright $pw_browsers (via $pw_pom)"
  elif [[ -n "$(seu_conf_all playwright_browser)" ]]; then
    # Fail here rather than after a 40-minute warm-up: a missing browser only
    # surfaces in the offline session, where it cannot be downloaded any more.
    if [[ -n "$(seu_conf playwright_pom "")" ]]; then
      die "playwright_pom points at a file that does not exist (see the warning above),
    but playwright_browser is set. Fix the path, or the browsers will be missing
    in every session."
    fi
    die "playwright_browser is set but playwright_pom is not.
    Set playwright_pom to the module whose pom puts com.microsoft.playwright on
    the classpath, for example:
        playwright_pom = club/club-ui/club-ui-test/pom.xml"
  fi
  msb exec -u seu "$BUILD_SANDBOX" \
    ${env_args[@]+"${env_args[@]}"} \
    -e "GITHUB_ACTOR=${GITHUB_ACTOR:-}" \
    -e "SEU_WITH_IMAGES=${with_images}" \
    -e "SEU_PREPULL_IMAGES=${prepull}" \
    -e "SEU_WARM_ARTIFACTS=${warm_artifacts}" \
    -e "SEU_PLAYWRIGHT_POM=${pw_pom}" \
    -e "SEU_PLAYWRIGHT_BROWSERS=${pw_browsers}" \
    -- bash -lc '/usr/local/bin/warm.sh' \
    || die "warm-up failed -- see the output above"

  # --------------------------------------------------------------- 6. teardown
  seu_teardown_build
  trap - EXIT INT TERM

  # ----------------------------------------------------------------- 7. session
  step "Starting the session sandbox"
  # shellcheck source=/dev/null
  source "$SEU_ROOT/lib/cmd-start.sh"; cmd_start

  step "Build complete"
  info "run 'seu shell' any time; 'seu stop' to suspend, 'seu pull' to get work out"
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
    ok "removed (its wide network access and host mounts are gone with it)"
  fi
}
