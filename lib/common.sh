# Shared helpers for seu. Sourced, never executed.
# macOS ships bash 3.2 -- no associative arrays, no mapfile/readarray.

set -euo pipefail

c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_red=$'\033[31m'
c_blu=$'\033[34m'; c_bld=$'\033[1m'; c_dim=$'\033[2m'; c_off=$'\033[0m'

step() { printf '\n%s==>%s %s%s%s\n' "$c_blu" "$c_off" "$c_bld" "$*" "$c_off" >&2; }
info() { printf '%s  %s%s\n' "$c_dim" "$*" "$c_off" >&2; }
ok()   { printf '%s  ok%s %s\n' "$c_grn" "$c_off" "$*" >&2; }
warn() { printf '%swarn%s %s\n' "$c_ylw" "$c_off" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

# `msb` resolves its libkrunfw runtime relative to the path it is invoked by and
# does NOT follow symlinks, so the ~/.local/bin/msb symlink fails with
# "installation is incomplete". Always use the real binary.
MSB="${SEU_MSB:-$HOME/.microsandbox/bin/msb}"

msb() { "$MSB" "$@"; }

# --------------------------------------------------------------- exec plumbing
# `msb exec --timeout` does NOT work: it neither returns nor kills the command
# when the budget expires. Every bounded call therefore gets a host-side watchdog.
# Returns 124 on timeout, like GNU timeout(1) (which macOS does not ship).
seu_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$! i=0
  while kill -0 "$pid" 2>/dev/null; do
    if [[ $i -ge $secs ]]; then
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 1
    i=$((i + 1))
  done
  wait "$pid"
}

# A bounded exec. Anything that could hang must go through this.
seu_exec() {
  local secs="$1"; shift
  seu_with_timeout "$secs" "$MSB" exec "$@"
}

# `msb create` and `msb start` return before agentd is ready to serve execs, and
# an exec issued in that window wedges FOREVER -- `msb ping` is no help, it exits
# non-zero even for a reachable sandbox. So poll with a real, bounded exec.
seu_wait_agent() {
  local sb="$1" i
  for i in $(seq 1 45); do
    seu_exec 10 -u root "$sb" -- true >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "sandbox $sb never became ready for commands"
}

# ---------------------------------------------------------------- project identity
# Resolves the git worktree containing $PWD. Mount sources must be real paths --
# /tmp is a symlink to /private/tmp on macOS and fails with "Not a directory" --
# so everything goes through `pwd -P`.
seu_resolve_project() {
  local start="${1:-$PWD}"
  [[ -d "$start" ]] || die "not a directory: $start"
  PROJECT="$(cd "$start" && git rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$PROJECT" ]] || die "not inside a git repository: $start"
  PROJECT="$(cd "$PROJECT" && pwd -P)"
  PROJECT_NAME="$(basename "$PROJECT")"

  # Worktrees, submodules and separate git dirs leave a .git *file* holding an
  # absolute host path. We mount the shared git dir at that same absolute path so
  # the pointer resolves unchanged inside the VM -- nothing is rewritten.
  GITDIR="$(cd "$PROJECT" && git rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$GITDIR" ]]; then
    case "$GITDIR" in
      /*) : ;;
      *)  GITDIR="$(cd "$PROJECT/$GITDIR" && pwd -P)" ;;
    esac
    [[ -d "$GITDIR" ]] || GITDIR=""
  fi
  # Only a *separate* git dir needs its own mount; an in-tree .git comes along
  # with /src automatically.
  case "${GITDIR:-}" in
    "$PROJECT"/*|"") GITDIR="" ;;
  esac

  local hash
  hash="$(printf '%s' "$PROJECT" | shasum -a 256 | cut -c1-8)"
  SLUG="${PROJECT_NAME}-${hash}"
  SANDBOX="seu-${SLUG}"
  BUILD_SANDBOX="seu-${SLUG}-build"
  STATE_DIR="${SEU_STATE_DIR:-$SEU_ROOT/.seu-state}/$SLUG"
  mkdir -p "$STATE_DIR"

  SEU_CONF_FILE="$PROJECT/.seu/config.conf"
}

# ------------------------------------------------------------- project profile
# `.seu/config.conf` in the project describes what this particular repository
# needs: the base-image name, which Maven servers it authenticates against, and
# which Docker images to have ready. It is DATA, never code -- seu is meant to
# distrust the repository it sandboxes, so the file is parsed with awk and no
# value is ever eval'd, sourced or word-split into a command.
#
# Format: `key = value`, one per line, `#` starts a full-line comment.
# A repeated key is how a list is written; order is preserved.
# One line: this is passed to awk with -v, which rejects an embedded newline.
SEU_CONF_KNOWN_KEYS="image_name mise_config maven_server prepull warm_artifact playwright_pom playwright_browser"

seu_conf_all() {
  [[ -n "${SEU_CONF_FILE:-}" && -f "$SEU_CONF_FILE" ]] || return 0
  awk -v want="$1" '
    /^[[:space:]]*#/ { next }
    {
      eq = index($0, "=")
      if (eq == 0) next
      k = substr($0, 1, eq - 1); v = substr($0, eq + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", k)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      if (k == want && v != "") print v
    }
  ' "$SEU_CONF_FILE"
}

# Last value wins, so a later line can override an earlier one.
seu_conf() {
  local v; v="$(seu_conf_all "$1" | tail -1)"
  printf '%s\n' "${v:-${2:-}}"
}

# Keys we do not understand are almost always typos. Report, never fail.
seu_conf_unknown_keys() {
  [[ -n "${SEU_CONF_FILE:-}" && -f "$SEU_CONF_FILE" ]] || return 0
  awk -v known=" $SEU_CONF_KNOWN_KEYS " '
    /^[[:space:]]*#/ { next }
    {
      eq = index($0, "=")
      if (eq == 0) next
      k = substr($0, 1, eq - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", k)
      if (k != "" && index(known, " " k " ") == 0) print k
    }
  ' "$SEU_CONF_FILE" | sort -u
}

# Everything below is handed to a command ON THE HOST, so validate hard.
seu_valid_image_ref() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]]; }

# Artifacts to resolve properly during the warm-up, as `groupId:artifactId:version`.
#
# This covers two things a file copy cannot. First, descriptors: an artifact's
# parent POMs usually live under other artifactId directories, and Maven cannot
# read a descriptor without the whole chain -- copying
# org/codehaus/plexus/plexus-java/1.5.2 yields "Failed to read artifact
# descriptor" because plexus-languages and plexus did not come along. Second,
# artifacts nothing declares: surefire and failsafe pick their provider jar
# (org.apache.maven.surefire:surefire-junit-platform) from the test framework
# they detect, so no pre-fetch goal ever asks for it -- but naming it here does.
#
# The usual case is a plugin invoked from the COMMAND LINE rather than bound in
# the POM (`default-cli` in the error message). Nothing in the warm-up can know
# about it, so `dependency:go-offline` and `dependency:resolve-plugins` skip it.
# Playwright downloads its browsers per platform, so the host's copies are
# useless here -- they are macOS builds and the guest needs linux-arm64. They
# must be fetched during `seu build`, into ~/.cache/ms-playwright, which is in the
# persistent volume. A browser not listed here is simply absent in the session,
# and the test that wants it fails with ENOTFOUND at the worst possible moment.
seu_playwright_browsers() {
  local b out=""
  while IFS= read -r b; do
    [[ -n "$b" ]] || continue
    [[ "$b" =~ ^[a-z][a-z0-9-]*$ ]] \
      || die "$SEU_CONF_FILE: not a usable Playwright browser name: $b"
    out="${out:+$out }$b"
  done < <(seu_conf_all playwright_browser)
  printf '%s\n' "${out:-chromium}"
}

# The module whose pom puts the Playwright Java client on the classpath, which is
# all `exec:java -Dexec.mainClass=com.microsoft.playwright.CLI` needs.
#
# Stated explicitly, never guessed. Searching the poms for the dependency looks
# attractive but misses the case where it is inherited from a parent or a BOM, and
# the failure mode is silence followed by an ENOTFOUND at test time, in a session
# that can no longer fix it. `playwright_browser` without this key is an error.
#
# Setting this key is what enables the step at all; a project with no Playwright
# simply omits it.
seu_playwright_pom() { seu_conf_relpath playwright_pom; }

# Project-relative path, validated and returned AS relative: the host checks it
# against $PROJECT, the VM resolves it against /work.
seu_conf_relpath() {
  local key="$1" v
  v="$(seu_conf "$key" "")"
  [[ -n "$v" ]] || return 1
  case "$v" in
    /*)   die "$SEU_CONF_FILE: $key must be relative to the project: $v" ;;
    *..*) die "$SEU_CONF_FILE: $key must not contain '..': $v" ;;
  esac
  [[ "$v" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] \
    || die "$SEU_CONF_FILE: not a usable path: $key = $v"
  [[ -f "$PROJECT/$v" ]] || { warn "$SEU_CONF_FILE: $key points at $v, which does not exist"; return 1; }
  printf '%s\n' "$v"
}

seu_warm_artifacts() {
  local a
  while IFS= read -r a; do
    [[ -n "$a" ]] || continue
    case "$a" in
      *:*:*) : ;;
      *) die "$SEU_CONF_FILE: warm_artifact needs groupId:artifactId:version: $a" ;;
    esac
    [[ "$a" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] \
      || die "$SEU_CONF_FILE: not a usable artifact coordinate: $a"
    printf '%s\n' "$a"
  done < <(seu_conf_all warm_artifact)
  return 0
}

# A path-valued key must stay inside the project. Prints the absolute path, or
# returns non-zero when unset or absent.
seu_conf_project_file() {
  local key="$1" v
  v="$(seu_conf "$key" "")"
  [[ -n "$v" ]] || return 1
  case "$v" in
    /*)    die "$SEU_CONF_FILE: $key must be relative to the project: $v" ;;
    *..*)  die "$SEU_CONF_FILE: $key must not contain '..': $v" ;;
  esac
  [[ -f "$PROJECT/$v" ]] || return 1
  printf '%s\n' "$PROJECT/$v"
}

# The mise toolchain file is optional: a project without one still gets a VM,
# just without a mise-managed JDK/Maven.
seu_mise_config() {
  local v configured
  if v="$(seu_conf_project_file mise_config)"; then printf '%s\n' "$v"; return 0; fi
  configured="$(seu_conf mise_config "")"
  if [[ -n "$configured" ]]; then
    # Configured but absent is a typo, not a project without a toolchain, and it
    # would otherwise produce a silently JDK-less image.
    warn "$SEU_CONF_FILE: mise_config points at $configured, which does not exist"
    return 1
  fi
  [[ -f "$PROJECT/mise.toml" ]] && { printf '%s\n' "$PROJECT/mise.toml"; return 0; }
  return 1
}

# ------------------------------------------------------------------------ volumes
# ONE named disk volume holds everything that must survive: microsandbox permits
# at most TWO managed additional disks per sandbox (a third fails with "managed
# additional disk has an invalid or reserved device id"), and a single volume
# lets space float between the Docker image store and the Maven repository
# instead of being partitioned up front.
#
# It is `--kind disk` (ext4), not a directory volume: overlay2 cannot use a
# virtiofs mount, and a Maven repository on virtiofs is painfully slow.
#
# Layout inside it, wired up by symlinks baked into vm/Dockerfile:
#   /seu/work    <- /work
#   /seu/m2      <- /home/seu/.m2
#   /seu/cache   <- /home/seu/.cache
#   /seu/docker  <- dockerd --data-root
SEU_VOLUME_MOUNT="/seu"
SEU_VOLUME_SIZE="${SEU_VOLUME_SIZE:-100G}"

vol_name() { printf 'seu-%s-data' "$SLUG"; }

seu_ensure_volumes() {
  local name; name="$(vol_name)"
  if msb volume list 2>/dev/null | awk '{print $1}' | grep -qx "$name"; then
    info "volume $name exists"
  else
    msb volume create --kind disk --size "$SEU_VOLUME_SIZE" "$name" >/dev/null \
      || die "could not create volume $name"
    ok "volume $name ($SEU_VOLUME_SIZE)"
  fi
}

# A named volume must be addressed with its full spec every time: --mount-named
# defaults to kind=dir and errors with "already exists as disk, but this sandbox
# requested dir", and a size that disagrees with the volume is rejected too.
seu_volume_args() {
  printf -- '--mount-named\n%s:%s:kind=disk,size=%s\n' \
    "$(vol_name)" "$SEU_VOLUME_MOUNT" "$SEU_VOLUME_SIZE"
}

# Emits the read-only source mounts.
seu_source_args() {
  printf -- '-v\n%s:/src:ro\n' "$PROJECT"
  [[ -n "${GITDIR:-}" ]] && printf -- '-v\n%s:%s:ro\n' "$GITDIR" "$GITDIR"
  return 0
}

# Creates the directory layout inside the named volume. Must run before anything
# resolves /work, ~/.m2 or ~/.cache: those are symlinks into /seu, and the volume
# mounts empty the first time. This is also why the sandbox is NOT created with
# `--workdir /work` -- msb validates the workdir at create time, when the symlink
# still dangles.
seu_bootstrap_volume() {
  seu_exec 60 -u root "$1" -- sh -c '
    mkdir -p /seu/work /seu/m2 /seu/cache /seu/docker
    chown seu:seu /seu /seu/work /seu/m2 /seu/cache
  ' >/dev/null 2>&1 || die "could not bootstrap the /seu volume layout"
}

# --------------------------------------------------------------------- sandbox state
seu_sandbox_state() {
  msb ls 2>/dev/null | awk -v n="$1" '$1 == n {print $3; found=1} END {if (!found) print "absent"}'
}

seu_sandbox_exists() { [[ "$(seu_sandbox_state "$1")" != "absent" ]]; }
seu_sandbox_running() { [[ "$(seu_sandbox_state "$1")" == "running" ]]; }

# ------------------------------------------------------------------------ dockerd
# dockerd runs in the foreground of a detached host-side `msb exec`. See
# seu/vm/dockerd-run.sh for why neither a backgrounded exec nor --init works.
seu_dockerd_pidfile() { printf '%s/dockerd-exec.pid' "$STATE_DIR"; }

seu_dockerd_running() {
  seu_exec 20 -u root "$1" -- sh -c 'docker info >/dev/null 2>&1' >/dev/null 2>&1
}

seu_start_dockerd() {
  local sb="$1" pidfile attempt i
  pidfile="$(seu_dockerd_pidfile)"

  if seu_dockerd_running "$sb"; then
    info "dockerd already running"
    return 0
  fi

  # Retried: on a freshly booted VM containerd sometimes loses its own startup
  # race and dockerd dies with "failed to start containerd: timeout waiting for
  # containerd to start". A second attempt against the now-warm guest succeeds.
  for attempt in 1 2 3; do
    nohup "$MSB" exec -u root "$sb" -- /usr/local/bin/dockerd-run.sh \
      >>"$STATE_DIR/dockerd-exec.log" 2>&1 &
    echo $! > "$pidfile"
    disown 2>/dev/null || true

    for i in $(seq 1 30); do
      seu_dockerd_running "$sb" && { ok "dockerd ready"; return 0; }
      sleep 2
    done

    seu_stop_dockerd
    [[ $attempt -lt 3 ]] && warn "dockerd did not come up (attempt $attempt/3); retrying"
  done

  warn "dockerd failed to start after 3 attempts"
  warn "host-side exec log: $STATE_DIR/dockerd-exec.log"
  seu_exec 20 -u root "$sb" -- sh -c 'tail -20 /var/log/dockerd.log' 2>&1 \
    | sed 's/^/    /' >&2 || true
  return 1
}

seu_stop_dockerd() {
  local pidfile pid
  pidfile="$(seu_dockerd_pidfile)"
  [[ -f "$pidfile" ]] || return 0
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

# --------------------------------------------------------------------- misc
# Base image name. Projects override it so two repositories never share (and
# invalidate) each other's image; the default is derived from the worktree.
seu_image_name() {
  local n; n="$(seu_conf image_name "")"
  if [[ -n "$n" ]]; then
    [[ "$n" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] \
      || die "$SEU_CONF_FILE: image_name must be a lowercase docker repository name: $n"
    printf '%s\n' "$n"
  else
    printf 'seu-vm-%s\n' \
      "$(printf '%s' "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')"
  fi
}

# Hash of everything that goes into the base image, so `build` can skip a rebuild.
# Only files that actually exist are hashed: a project without a mise config is
# legitimate, and the old unconditional `cat .../mise.toml` failed silently into
# the pipe, producing a hash that did not cover what it claimed to.
seu_image_tag() {
  local files h mise
  files=("$SEU_ROOT/vm/Dockerfile" "$SEU_ROOT/vm/dockerd-run.sh" \
         "$SEU_ROOT/vm/session-init.sh" "$SEU_ROOT/vm/warm.sh" \
         "$SEU_ROOT/vm/claude-settings.json")
  if mise="$(seu_mise_config)"; then files+=("$mise"); fi
  h="$(cat "${files[@]}" | shasum -a 256 | cut -c1-12)" || die "could not hash the image inputs"
  printf '%s:%s' "$(seu_image_name)" "$h"
}

# True when exactly this reference is in microsandbox's image store.
# Must match the FULL reference, name included: seu_image_tag's hash covers only
# the image inputs (vm/* and mise.toml), which are identical across worktrees of
# the same repo, so a hash-only test matches a sibling worktree's image. `msb
# create` would then be handed a name that is not in the store and silently fall
# back to pulling it from docker.io -- which fails with "Not authorized".
seu_image_loaded() {
  msb image list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qxF "$1"
}

# ------------------------------------------------- host Maven repository (build)
# The developer's ~/.m2/repository is mounted READ-ONLY into the build sandbox
# and declared as a file:// repository, so Maven copies what this project needs
# out of it instead of downloading it again. It is far too large to copy
# wholesale (139G here, against a 100G volume) and virtiofs is slow, so it is a
# resolution SOURCE, never a seed.
#
# It is mounted into the BUILD sandbox only. cmd-start.sh must never use this.
SEU_HOST_M2="${SEU_HOST_M2:-$HOME/.m2/repository}"
SEU_HOST_M2_MOUNT="/host-m2"
SEU_HOST_IMAGES_MOUNT="/host-images"

seu_host_images_dir() { printf '%s/host-images' "$STATE_DIR"; }
seu_host_images_tar() { printf '%s/host-images/images.tar' "$STATE_DIR"; }

# Mounts that exist ONLY while `seu build` runs. Emits one argument per line.
seu_build_mount_args() {
  local p
  if [[ "${SEU_USE_HOST_M2:-1}" == "1" && -d "$SEU_HOST_M2" ]]; then
    p="$(cd "$SEU_HOST_M2" && pwd -P)"
    printf -- '-v\n%s:%s:ro,uid=1000,gid=1000\n' "$p" "$SEU_HOST_M2_MOUNT"
  fi
  if [[ -f "$(seu_host_images_tar)" ]]; then
    p="$(cd "$(seu_host_images_dir)" && pwd -P)"
    printf -- '-v\n%s:%s:ro,uid=1000,gid=1000\n' "$p" "$SEU_HOST_IMAGES_MOUNT"
  fi
  return 0
}

# ----------------------------------------------------------- host Docker images
# `docker save` the `prepull` images the host already has into ONE tar (shared
# layers are then stored once) for the build sandbox to `docker load`. Saves the
# whole pull phase on every rebuild.
#
# The architecture check is not optional. Loading an amd64 image into the arm64
# guest reproduces exactly the "exec format error" the README documents for
# half-pulled images: the container's architecture looks perfectly correct right
# up until its entrypoint fails to exec.
seu_export_host_images() {
  local refresh="${1:-0}" dir tar idsfile img meta arch manifest
  dir="$(seu_host_images_dir)"; tar="$dir/images.tar"; idsfile="$dir/images.ids"
  mkdir -p "$dir"

  local refs=() ids=()
  while IFS= read -r img; do
    [[ -n "$img" ]] || continue
    seu_valid_image_ref "$img" \
      || die "$SEU_CONF_FILE: not a usable image reference: $img"
    if ! meta="$(docker image inspect --format '{{.Id}} {{.Architecture}}/{{.Os}}' "$img" 2>/dev/null)"; then
      info "$img -- not on the host; the warm-up will pull it"
      continue
    fi
    arch="${meta#* }"
    if [[ "$arch" != "arm64/linux" ]]; then
      warn "$img is $arch, not arm64/linux -- skipped (loading it would break the VM)"
      continue
    fi
    refs+=("$img"); ids+=("${meta%% *}")
  done < <(seu_conf_all prepull)

  if [[ ${#refs[@]} -eq 0 ]]; then
    info "no host images to reuse"
    rm -f "$tar" "$idsfile"
    return 0
  fi

  manifest="$(printf '%s\n' "${ids[@]}" | sort)"
  if [[ "$refresh" != "1" && -f "$tar" && -f "$idsfile" ]] \
     && [[ "$manifest" == "$(cat "$idsfile")" ]]; then
    ok "${#refs[@]} host image(s) already staged ($(du -h "$tar" | awk '{print $1}'))"
    return 0
  fi

  info "saving ${#refs[@]} host image(s) -- this reads from the host Docker daemon"
  rm -f "$idsfile"
  docker save -o "$tar.tmp" "${refs[@]}" \
    || { rm -f "$tar.tmp"; die "docker save failed for: ${refs[*]}"; }
  mv "$tar.tmp" "$tar"
  printf '%s\n' "$manifest" > "$idsfile"
  ok "staged $(du -h "$tar" | awk '{print $1}') of host images"
}

# ------------------------------------------------------------ Maven credentials
# Credentials for the servers named by `maven_server` in the project profile.
# They are read from ~/.m2/settings.xml (or GITHUB_ACTOR/GITHUB_TOKEN as a
# fallback) and emitted as SEU_MVN_<ID>_USER / _PASS assignments which cmd-build
# passes to the warm-up through `msb exec -e`. The generated in-VM settings.xml
# only ever contains ${env.*} placeholders, so no secret is written to disk
# inside the VM -- and the session sandbox is created without any of them.
seu_maven_server_args() {
  local id
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    printf -- '--server\n%s\n' "$id"
  done < <(seu_conf_all maven_server)
  return 0
}

NET_PROFILE="${SEU_NET:-session}"
seu_net_conf() { printf '%s/config/net-%s.yaml' "$SEU_ROOT" "$NET_PROFILE"; }
