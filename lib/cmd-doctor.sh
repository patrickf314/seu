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


  step "Profile"
  if [[ -f "$SEU_CONF_FILE" ]]; then
    ok "${SEU_CONF_FILE#$PROJECT/}"
    local unknown; unknown="$(seu_conf_unknown_keys)"
    if [[ -n "$unknown" ]]; then
      warn "unknown keys: $(printf '%s' "$unknown" | tr '\n' ' ')"
    fi
  else
    info "no .seu/config.conf -- defaults apply"
  fi
  ok "image     $(seu_image_name)"
  local mise
  if mise="$(seu_mise_config)"; then ok "toolchain ${mise#$PROJECT/}"
  else info "toolchain no mise config; the image gets no managed JDK/Maven"; fi

  step "Host Maven repository (\`seu build\` only)"
  if [[ "${SEU_USE_HOST_M2:-1}" != "1" ]]; then
    info "disabled via SEU_USE_HOST_M2=0"
  elif [[ -d "$SEU_HOST_M2" ]]; then
    ok "$SEU_HOST_M2 -- mounted read-only at $SEU_HOST_M2_MOUNT in the build sandbox"
  else
    info "$SEU_HOST_M2 does not exist; everything will be downloaded"
  fi

  local servers; servers="$(seu_conf_all maven_server | tr '\n' ' ')"
  if [[ -n "$servers" ]]; then
    local have; have="$(python3 "$SEU_ROOT/lib/maven-settings.py" --list-servers \
                          $(seu_conf_all maven_server | sed 's/^/--server /') 2>/dev/null | tr '\n' ' ')"
    if [[ -n "$have" ]]; then ok "credentials  $have"
    elif [[ -n "${GITHUB_TOKEN:-}" ]]; then ok "credentials  from GITHUB_ACTOR/GITHUB_TOKEN"
    else warn "no credentials for: $servers -- \`seu build\` will fail"; fi
  else
    info "no maven_server configured; no credentials needed"
  fi

  step "Playwright"
  local pw_pom; pw_pom="$(seu_playwright_pom || true)"
  if [[ -n "$pw_pom" ]]; then
    ok "$(seu_playwright_browsers) -- via $pw_pom"
  elif [[ -n "$(seu_conf_all playwright_browser)" ]]; then
    if [[ -n "$(seu_conf playwright_pom "")" ]]; then
      warn "playwright_pom does not resolve (see above) -- \`seu build\` will refuse"
    else
      warn "playwright_browser is set but playwright_pom is not -- \`seu build\` will refuse"
    fi
  else
    info "no playwright_pom; the browser download is skipped"
  fi

  step "Docker images to reuse from the host"
  local img meta arch staged=0 missing=0 wrongarch=0
  while IFS= read -r img; do
    [[ -n "$img" ]] || continue
    if ! meta="$(docker image inspect --format '{{.Architecture}}/{{.Os}}' "$img" 2>/dev/null)"; then
      info "$img -- not on the host, will be pulled in the VM"; missing=$((missing + 1)); continue
    fi
    if [[ "$meta" != "arm64/linux" ]]; then
      warn "$img is $meta, not arm64/linux -- will be pulled instead"; wrongarch=$((wrongarch + 1)); continue
    fi
    staged=$((staged + 1))
  done < <(seu_conf_all prepull)
  if [[ $((staged + missing + wrongarch)) -eq 0 ]]; then
    info "no prepull entries in the profile"
  else
    ok "$staged reusable, $missing to pull, $wrongarch wrong-arch"
    [[ -f "$(seu_host_images_tar)" ]] \
      && ok "staged tar $(du -h "$(seu_host_images_tar)" | awk '{print $1}') at $(seu_host_images_tar)" \
      || info "nothing staged yet -- \`seu build\` writes it"
  fi

  step "Base image"
  local tag; tag="$(seu_image_tag)"
  if seu_image_loaded "$tag"; then ok "$tag loaded"
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
