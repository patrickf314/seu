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

# ------------------------------------------------------------------- host SSH
# Port forwarding rides on `msb ssh`, not on `msb create -p`.
#
# `msb create` does take `-p HOST:GUEST`, but ports are fixed at CREATE time --
# `msb modify` has no port flag at all. Using it would mean re-creating the
# sandbox every time a port is added: root disk gone, dockerd and session-init
# re-run, every running process killed. For "let me look at my dev server" that
# is useless.
#
# microsandbox's SSH server implements the `direct-tcpip` channel and relays it
# into the guest, so plain openssh `ssh -N -L` forwards into a RUNNING sandbox
# with nothing restarted. `msb ssh serve --stdio <sb>` serves one SSH transport
# over stdin/stdout, which is exactly what ProxyCommand wants.
#
# The key is seu's own, under the state dir -- never ~/.ssh. `msb ssh serve`
# refuses to run without an authorized key ("SSH server has no authorized public
# keys"), and `msb ssh authorize` is idempotent.
SEU_SSH_DIR="${SEU_STATE_DIR:-$SEU_ROOT/.seu-state}/ssh"

seu_ssh_key() {
  local key="$SEU_SSH_DIR/id_ed25519"
  if [[ ! -f "$key" ]]; then
    mkdir -p "$SEU_SSH_DIR"
    command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen not found -- seu port needs OpenSSH"
    ssh-keygen -t ed25519 -N '' -C seu -f "$key" -q >/dev/null \
      || die "could not generate the seu SSH key at $key"
  fi
  printf '%s\n' "$key"
}

seu_ssh_authorize() {
  local key; key="$(seu_ssh_key)"
  msb ssh authorize --file "$key.pub" >/dev/null 2>&1 \
    || die "msb ssh authorize failed for $key.pub"
}

# openssh options, ONE ARGUMENT PER LINE (the seu_source_args idiom -- bash 3.2
# has no mapfile). -F /dev/null so a personal ~/.ssh/config cannot redirect this.
seu_ssh_args() {
  local sb="$1" key; key="$(seu_ssh_key)"
  printf -- '-F\n/dev/null\n'
  printf -- '-i\n%s\n' "$key"
  printf -- '-o\nIdentitiesOnly=yes\n'
  printf -- '-o\nStrictHostKeyChecking=no\n'
  printf -- '-o\nUserKnownHostsFile=/dev/null\n'
  printf -- '-o\nLogLevel=ERROR\n'
  printf -- '-o\nExitOnForwardFailure=yes\n'
  printf -- '-o\nServerAliveInterval=30\n'
  printf -- '-o\nProxyCommand=%s ssh serve --stdio --no-inactivity-timeout %s\n' "$MSB" "$sb"
}

# ------------------------------------------------------------ port forwarding
# A spec is docker's: GUEST, HOST:GUEST, or BIND:HOST:GUEST. Prints
# "<bind> <hostport> <guestport>". Validated hard -- it ends up in an `ssh -L`
# argument, and a seu invariant is that nothing from outside is trusted.
#
# The default bind is 127.0.0.1, not 0.0.0.0: a forward into a sandbox should
# not quietly publish that sandbox to the local network. Ask for `*:` to do that.
seu_port_parse() {
  local spec="$1" bind host guest
  case "$spec" in
    */udp|*/UDP) die "ssh -L forwards TCP only, so $spec is not supported" ;;
    */tcp|*/TCP) spec="${spec%/*}" ;;
  esac

  case "$spec" in
    *:*:*:*) die "not a usable port spec: $spec (expected PORT, HOST:GUEST or BIND:HOST:GUEST)" ;;
    *:*:*)   bind="${spec%%:*}"; spec="${spec#*:}"; host="${spec%%:*}"; guest="${spec#*:}" ;;
    *:*)     bind="127.0.0.1";   host="${spec%%:*}"; guest="${spec#*:}" ;;
    *)       bind="127.0.0.1";   host="$spec";       guest="$spec" ;;
  esac

  [[ "$bind" == "*" ]] && bind="0.0.0.0"
  [[ "$bind" == "localhost" ]] && bind="127.0.0.1"
  [[ "$bind" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] \
    || die "not a usable bind address: $bind (use an IPv4 literal, localhost or *)"

  local p
  for p in "$host" "$guest"; do
    [[ "$p" =~ ^[0-9]{1,5}$ ]] && [[ "$p" -ge 1 ]] && [[ "$p" -le 65535 ]] \
      || die "not a usable port: $p (1-65535)"
  done

  printf '%s %s %s\n' "$bind" "$host" "$guest"
}

# One file per forward, keyed by HOST port -- that is what is unique on the Mac.
#   $STATE_DIR/ports/<hostport>.fwd   "<bind> <hostport> <guestport> <pid>"
#   $STATE_DIR/ports/<hostport>.log   that tunnel's ssh stderr
seu_port_dir() { printf '%s/ports' "$STATE_DIR"; }

seu_port_pid() {
  local f; f="$(seu_port_dir)/$1.fwd"
  [[ -f "$f" ]] || return 1
  awk '{print $4}' "$f"
}

seu_port_up() {
  local pid; pid="$(seu_port_pid "$1")" || return 1
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# Prints "<bind> <hostport> <guestport> <pid>" per LIVE forward, pruning the
# records whose ssh has died (a tunnel does not survive `seu stop`).
seu_port_list() {
  local dir f port
  dir="$(seu_port_dir)"
  [[ -d "$dir" ]] || return 0
  for f in "$dir"/*.fwd; do
    [[ -f "$f" ]] || continue
    port="$(basename "$f" .fwd)"
    if seu_port_up "$port"; then cat "$f"; else rm -f "$f"; fi
  done
  return 0
}

# bash's own /dev/tcp rather than nc(1): no external dependency, and a missing
# nc would otherwise make every probe answer "free", which turns the busy-port
# guard below into a no-op and the readiness poll into a guaranteed timeout.
seu_host_port_listening() {
  local h="$1"
  [[ "$h" == "0.0.0.0" ]] && h="127.0.0.1"
  (exec 3<>"/dev/tcp/$h/$2") >/dev/null 2>&1
}

seu_port_start() {
  local bind="$1" host="$2" guest="$3" sb="${4:-$SANDBOX}"
  local dir log args=() i pid
  dir="$(seu_port_dir)"; mkdir -p "$dir"
  log="$dir/$host.log"

  if seu_port_up "$host"; then
    info "$bind:$host -> vm:$guest already forwarded"
    return 0
  fi
  rm -f "$dir/$host.fwd"

  # Check the host port BEFORE starting ssh. Afterwards "something is listening
  # on $host" is ambiguous -- it could be the squatter rather than our tunnel,
  # which is exactly how a failed bind used to get reported as a success.
  if seu_host_port_listening "$bind" "$host"; then
    warn "host port $host is already in use -- not forwarding to vm:$guest"
    info "$(lsof -nP -iTCP:"$host" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print "held by "$1" (pid "$2")"}')"
    return 1
  fi

  while IFS= read -r a; do args+=("$a"); done < <(seu_ssh_args "$sb")

  : > "$log"
  # The guest-side destination is `localhost`, NOT the 127.0.0.1 literal. A Vite
  # dev server binds [::1] only, so an IPv4 literal finds nothing there and the
  # forward comes up but refuses every connection. `localhost` lets the guest
  # resolver try both families, which also reaches 127.0.0.1-only listeners
  # (the trace viewer) and 0.0.0.0 ones (docker-proxy).
  nohup ssh "${args[@]}" -N -L "$bind:$host:localhost:$guest" "seu@$sb" \
    >>"$log" 2>&1 &
  pid=$!
  disown 2>/dev/null || true
  printf '%s %s %s %s\n' "$bind" "$host" "$guest" "$pid" > "$dir/$host.fwd"

  # ExitOnForwardFailure turns a busy host port into a clean, fast ssh exit, so
  # a dead pid here is a real diagnosis and not just a slow start.
  for i in $(seq 1 15); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$dir/$host.fwd"
      warn "could not forward $bind:$host -> vm:$guest"
      sed 's/^/    /' "$log" >&2
      return 1
    fi
    if seu_host_port_listening "$bind" "$host"; then
      # The port was free a moment ago, so a listener now is ours. Give ssh a
      # beat to fall over anyway, then confirm it is still there.
      sleep 1
      kill -0 "$pid" 2>/dev/null && { ok "$bind:$host -> vm:$guest"; return 0; }
      continue
    fi
    sleep 1
  done

  warn "$bind:$host -> vm:$guest: ssh is running but the port never opened"
  sed 's/^/    /' "$log" >&2
  return 1
}

# The log goes with the record. A tunnel that came up cleanly leaves an empty
# one; a tunnel that failed never gets here, so its log survives to be read.
seu_port_stop() {
  local host="$1" dir pid
  dir="$(seu_port_dir)"
  pid="$(seu_port_pid "$host" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  rm -f "$dir/$host.fwd" "$dir/$host.log"
}

seu_port_stop_all() {
  local dir f
  dir="$(seu_port_dir)"
  [[ -d "$dir" ]] || return 0
  for f in "$dir"/*.fwd; do
    [[ -f "$f" ]] || continue
    seu_port_stop "$(basename "$f" .fwd)"
  done
  return 0
}

# ------------------------------------------- Claude Code configuration + auth
# The developer configures Claude Code once, on their Mac. A VM that ignores
# that starts every session with a fresh /login, the default status line and
# whatever effort level the CLI ships with -- so seu projects the host's
# configuration into the guest on every start. At START time, not into the
# image: changing a setting then costs nothing, where a baked copy would cost a
# full rebuild.
#
# Three documents go in (see lib/claude-config.py for what each one keeps):
#
#   settings.json   ~/.claude/settings.json with the host-only parts dropped and
#                   vm/claude-settings.json merged ON TOP, so the sandbox's own
#                   hardening always wins over anything the host says.
#   ccstatusline    ~/.config/ccstatusline/settings.json, with an SEU badge
#                   prepended so a VM shell can never be read as a host shell.
#   .claude.json    the account/onboarding subset, MERGED into whatever the
#                   guest already has.
#
# Plus the OAuth credentials, which is the one part that is a secret. All of it
# lands on the sandbox's ROOT disk, never in the /seu volume and never in the
# image: the root disk is re-created from the image whenever the sandbox is,
# which is exactly the lifetime a copied credential should have.
SEU_CLAUDE_STAGE="/tmp/seu-claude"

# macOS keeps the Claude Code tokens in the login Keychain; Linux keeps them in
# $CLAUDE_CONFIG_DIR/.credentials.json. Reading the one and writing the other is
# the whole of "copy the authentication" -- there is no login flow to replay,
# and `/login` inside the VM would want a browser the guest does not have.
#
# The first read raises a Keychain prompt. "Always Allow" and it never asks
# again. A denied prompt is not an error: the session simply starts logged out.
seu_keychain_credentials() {
  security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null
}

# The guest half, passed as an ARGUMENT to python3 rather than copied in as a
# script: nothing inside the VM can rewrite an argv between the copy and the
# exec, and it runs as `seu`, so no part of this needs root.
seu_claude_guest_program() {
  cat <<'PY'
import json, os, shutil

HOME = os.path.expanduser("~")
CFG = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
STAGE = "/tmp/seu-claude"  # keep in step with SEU_CLAUDE_STAGE
done = []

def staged(name):
    try:
        with open(os.path.join(STAGE, name), encoding="utf-8") as fh:
            value = json.load(fh)
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None

def put(path, data, mode):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".seu-tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.chmod(tmp, mode)
    os.replace(tmp, path)

settings = staged("settings.json")
if settings is not None:
    put(os.path.join(CFG, "settings.json"), settings, 0o644)
    done.append("settings")

statusline = staged("ccstatusline.json")
if statusline is not None:
    put(os.path.join(HOME, ".config", "ccstatusline", "settings.json"), statusline, 0o644)
    done.append("statusline")

identity = staged("identity.json")
if identity is not None:
    # MERGED, never replaced: .claude.json is also where Claude keeps this VM's
    # own per-directory state, and overwriting it would throw away the history
    # behind `claude --continue`. Written to both locations because which one is
    # authoritative depends on whether CLAUDE_CONFIG_DIR is honoured for it.
    for path in (os.path.join(CFG, ".claude.json"), os.path.join(HOME, ".claude.json")):
        try:
            with open(path, encoding="utf-8") as fh:
                current = json.load(fh)
        except (OSError, ValueError):
            current = {}
        if not isinstance(current, dict):
            current = {}
        current.update(identity)
        put(path, current, 0o600)
    done.append("identity")

credentials = staged("credentials.json")
if credentials is not None:
    def expiry(blob):
        try:
            return int(blob["claudeAiOauth"]["expiresAt"])
        except (KeyError, TypeError, ValueError):
            return 0
    path = os.path.join(CFG, ".credentials.json")
    try:
        with open(path, encoding="utf-8") as fh:
            current = json.load(fh)
    except (OSError, ValueError):
        current = None
    # Host and guest refresh their tokens independently, so by the second start
    # the guest's copy may well be the fresher one. Keep whichever lives longest
    # instead of clobbering a working session with a stale Keychain blob.
    if current is None or expiry(credentials) > expiry(current):
        put(path, credentials, 0o600)
        done.append("credentials")
    else:
        done.append("credentials (kept the guest's newer token)")

shutil.rmtree(STAGE, ignore_errors=True)
print(", ".join(done) if done else "nothing to sync")
PY
}

seu_sync_claude_config() {
  local sb="$1"

  if [[ "${SEU_SYNC_CLAUDE:-1}" != "1" ]]; then
    info "SEU_SYNC_CLAUDE=0 -- the VM keeps the image's own Claude config"
    return 0
  fi

  local stage="$STATE_DIR/claude" py="$SEU_ROOT/lib/claude-config.py"
  rm -rf "$stage"
  (umask 077 && mkdir -p "$stage") || { warn "could not stage the Claude config"; return 0; }

  # A broken host config must not take the session down with it: every step
  # below degrades to "the image's own default stays in place".
  local staged=()
  if python3 "$py" settings \
       --host "$HOME/.claude/settings.json" \
       --base "$SEU_ROOT/vm/claude-settings.json" > "$stage/settings.json"; then
    staged+=(settings.json)
  else
    warn "could not build the in-VM settings.json; the image default stays"
  fi

  if python3 "$py" statusline \
       --host "$HOME/.config/ccstatusline/settings.json" \
       --label "SEU $PROJECT_NAME" > "$stage/ccstatusline.json"; then
    staged+=(ccstatusline.json)
  else
    warn "could not build the ccstatusline config"
  fi

  if python3 "$py" identity --host "$HOME/.claude.json" > "$stage/identity.json"; then
    staged+=(identity.json)
  else
    warn "could not build the Claude identity"
  fi

  if [[ "${SEU_SYNC_AUTH:-1}" != "1" ]]; then
    info "SEU_SYNC_AUTH=0 -- no credentials copied; run /login inside the VM"
  elif seu_keychain_credentials > "$stage/credentials.json" 2>/dev/null \
       && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$stage/credentials.json" 2>/dev/null; then
    staged+=(credentials.json)
  else
    rm -f "$stage/credentials.json"
    warn "no Claude Code credentials in the login Keychain -- run /login inside the VM"
  fi

  if [[ ${#staged[@]} -eq 0 ]]; then
    rm -rf "$stage"
    return 0
  fi

  # 0700, because the staging copies are briefly world-readable: `msb copy` sets
  # the mode, and the guest program is what tightens the destinations to 0600.
  seu_exec 30 -u seu "$sb" -- sh -c \
    "rm -rf '$SEU_CLAUDE_STAGE' && mkdir -m 700 -p '$SEU_CLAUDE_STAGE'" >/dev/null 2>&1 \
    || { warn "could not prepare the Claude config staging directory in the VM"; rm -rf "$stage"; return 0; }

  local f
  for f in "${staged[@]}"; do
    msb copy "$stage/$f" "$sb:$SEU_CLAUDE_STAGE/$f" >/dev/null 2>&1 \
      || warn "could not copy $f into the VM"
  done
  # The host copies exist only for the length of this function. The secret is in
  # the VM now and in the Keychain, and nowhere else on disk.
  rm -rf "$stage"

  local applied
  if applied="$(seu_exec 60 -u seu "$sb" -- python3 -c "$(seu_claude_guest_program)" 2>&1)"; then
    ok "claude config: $(printf '%s' "$applied" | tail -1)"
  else
    warn "could not apply the Claude config in the VM"
    printf '%s\n' "$applied" | sed 's/^/    /' >&2
  fi
}
