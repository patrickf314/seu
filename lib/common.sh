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
  STATE_DIR="$SEU_ROOT/.seu-state/$SLUG"
  mkdir -p "$STATE_DIR"
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
# Hash of everything that goes into the base image, so `build` can skip a rebuild.
seu_image_tag() {
  local h
  h="$(cat "$SEU_ROOT/vm/Dockerfile" "$SEU_ROOT/vm/dockerd-run.sh" \
           "$SEU_ROOT/vm/session-init.sh" "$SEU_ROOT/vm/warm.sh" \
           "$SEU_ROOT/vm/claude-settings.json" "$PROJECT/mise.toml" \
       | shasum -a 256 | cut -c1-12)"
  printf 'seu-vm-website-react:%s' "$h"
}

# ------------------------------------------------------------ GitHub credentials
# The Maven build resolves devx-repository and ui-test-components-repository from
# GitHub Packages, which requires auth even for reads. Prefer the environment;
# otherwise fall back to the credentials the developer already has in
# ~/.m2/settings.xml (the setup the project README documents).
# Sets GITHUB_ACTOR / GITHUB_TOKEN. Values are never echoed.
seu_load_github_credentials() {
  [[ -n "${GITHUB_TOKEN:-}" ]] && return 0

  local f="$HOME/.m2/settings.xml" creds
  [[ -f "$f" ]] || return 1
  creds="$(python3 "$SEU_ROOT/lib/read-maven-credentials.py" "$f" 2>/dev/null || true)"
  [[ -n "$creds" ]] || return 1

  GITHUB_ACTOR="$(printf '%s\n' "$creds" | sed -n 1p)"
  GITHUB_TOKEN="$(printf '%s\n' "$creds" | sed -n 2p)"
  export GITHUB_ACTOR GITHUB_TOKEN
  [[ -n "$GITHUB_TOKEN" ]]
}

NET_PROFILE="${SEU_NET:-session}"
seu_net_conf() { printf '%s/config/net-%s.yaml' "$SEU_ROOT" "$NET_PROFILE"; }
