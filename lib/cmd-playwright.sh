# shellcheck source=/dev/null
source "$SEU_ROOT/lib/common.sh"

# seu playwright -- reach Playwright's own tooling inside the VM.
#
# Today that is just the trace viewer. The trace never leaves the sandbox: the
# viewer runs in the guest and only its HTTP port is forwarded out, so the host
# needs no node, no npx and no network.
cmd_playwright() {
  local sub="${1:-}"; [[ $# -gt 0 ]] && shift || true
  case "$sub" in
    trace)        seu_pw_trace "$@" ;;
    -h|--help|"") pw_usage ;;
    *) printf 'seu playwright: unknown subcommand %q\n\n' "$sub" >&2; pw_usage ;;
  esac
}

pw_usage() {
  cat >&2 <<'USAGE'
seu playwright -- Playwright tooling inside the VM

usage: seu playwright trace <path> [--port N]

  <path>      the trace, relative to /work (a leading /work/ is accepted too),
              e.g. club/club-ui/club-ui-test/target/trace.zip
  --port N    host port for the viewer (default 9323, the next free one upward)

Starts Playwright's trace viewer in the VM, forwards its port to your Mac and
opens it in your browser. The trace file itself stays in the sandbox. Ctrl-C
stops the viewer and drops the forward.

Needs `playwright_pom` in .seu/config.conf -- the viewer ships inside the
Playwright jar, and that module's pom is what puts it on the classpath.
USAGE
  exit 2
}

# The path is interpolated into a command that runs INSIDE the VM, so it gets
# the same treatment as every other outside-supplied path in seu: validated
# against an explicit character class, never just quoted and hoped for.
seu_guest_relpath() {
  local v="$1"
  v="${v#/work/}"
  case "$v" in
    /*)   die "the trace path must be relative to /work: $1" ;;
    *..*) die "the trace path must not contain '..': $1" ;;
  esac
  [[ "$v" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "not a usable trace path: $1"
  printf '%s\n' "$v"
}

seu_pw_trace() {
  local rel="" hport="" arg
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) shift; [[ $# -gt 0 ]] || die "--port needs a number"; hport="$1" ;;
      -h|--help) pw_usage ;;
      -*) die "unknown option for playwright trace: $1" ;;
      *)  [[ -z "$rel" ]] || die "one trace at a time, got: $rel and $1"; rel="$1" ;;
    esac
    shift
  done
  [[ -n "$rel" ]] || die "which trace? e.g. \`seu playwright trace club/ui/target/trace.zip\`"
  rel="$(seu_guest_relpath "$rel")"

  seu_resolve_project "$PWD"
  seu_sandbox_running "$SANDBOX" \
    || die "$SANDBOX is $(seu_sandbox_state "$SANDBOX") -- \`seu start\` first"

  seu_exec 30 -u seu "$SANDBOX" -- test -f "/work/$rel" >/dev/null 2>&1 \
    || die "no such file in the VM: /work/$rel"

  local pom
  pom="$(seu_playwright_pom)" || die "this project has no playwright_pom in .seu/config.conf.
    The trace viewer ships inside the Playwright jar, so seu needs the module
    whose pom puts com.microsoft.playwright on the classpath, e.g.
        playwright_pom = club/club-ui/club-ui-test/pom.xml"

  # Same port inside and out when we can -- it makes the logs readable.
  if [[ -n "$hport" ]]; then
    [[ "$hport" =~ ^[0-9]{1,5}$ ]] && [[ "$hport" -ge 1 ]] && [[ "$hport" -le 65535 ]] \
      || die "not a usable port: $hport"
    ! seu_host_port_listening 127.0.0.1 "$hport" || die "host port $hport is already in use"
  else
    local p
    for p in $(seq 9323 9333); do
      if ! seu_host_port_listening 127.0.0.1 "$p"; then hport="$p"; break; fi
    done
    [[ -n "$hport" ]] || die "no free host port between 9323 and 9333"
  fi
  local gport="$hport"

  local log pidfile
  log="$STATE_DIR/playwright-trace.log"
  pidfile="$STATE_DIR/playwright-trace.pid"

  # shellcheck disable=SC2064
  trap "seu_pw_trace_cleanup '$hport'" INT TERM EXIT

  step "Starting the trace viewer in $SANDBOX"
  info "/work/$rel"
  : > "$log"
  # Detached host-side exec, exactly like dockerd (see seu_start_dockerd): a
  # process backgrounded *inside* an exec dies with that exec's session.
  # -o because a session has no network to Maven Central. --host/--port is what
  # makes show-trace SERVE the viewer rather than launch the bundled browser
  # app; it still tries to open a browser tab in the guest, but Playwright
  # swallows that failure and the server stays up.
  nohup "$MSB" exec -u seu "$SANDBOX" -- bash -lc "cd /work && exec mvn -B -o exec:java \
      --file '$pom' \
      -Dexec.mainClass=com.microsoft.playwright.CLI \
      -Dexec.args='show-trace --host 127.0.0.1 --port $gport /work/$rel'" \
    >>"$log" 2>&1 &
  echo $! > "$pidfile"
  disown 2>/dev/null || true

  # A cold `mvn exec:java` is slow, and the driver unpacks its node bundle on
  # first use, so this budget is generous on purpose.
  local i up=0
  for i in $(seq 1 60); do
    kill -0 "$(cat "$pidfile")" 2>/dev/null \
      || { warn "the viewer exited before it opened a port"; sed 's/^/    /' "$log" >&2; die "trace viewer failed to start"; }
    if seu_exec 10 -u seu "$SANDBOX" -- bash -lc "exec 3<>/dev/tcp/127.0.0.1/$gport" >/dev/null 2>&1; then
      up=1; break
    fi
    sleep 2
  done
  [[ $up -eq 1 ]] || { sed 's/^/    /' "$log" >&2; die "the trace viewer never opened vm:$gport"; }
  ok "viewer on vm:$gport"

  step "Forwarding vm:$gport"
  seu_ssh_authorize
  seu_port_start 127.0.0.1 "$hport" "$gport" || die "could not forward the viewer out"

  # The bare origin is the right URL: show-trace installs a RELATIVE root
  # redirect (./trace/index.html?trace=...), which the browser resolves against
  # whatever origin it asked -- so the forwarded host:port carries the query
  # along without any rewriting here.
  local url="http://127.0.0.1:$hport/"

  ok "$url"
  command -v open >/dev/null 2>&1 && open "$url" >/dev/null 2>&1 || true
  info "Ctrl-C to stop the viewer and drop the forward"
  # Block until the viewer dies or the user interrupts. The pid is read once:
  # re-reading a vanished pidfile and falling back to 0 would ask `kill -0` about
  # process group 0 -- which always succeeds, and spins here forever.
  local vpid; vpid="$(cat "$pidfile")"
  while kill -0 "$vpid" 2>/dev/null; do sleep 1; done
  warn "the trace viewer exited"
}

seu_pw_trace_cleanup() {
  trap - INT TERM EXIT
  local hport="$1" pidfile pid
  pidfile="$STATE_DIR/playwright-trace.pid"
  [[ -n "$hport" ]] && seu_port_stop "$hport"
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  rm -f "$pidfile"
  # Killing the host-side exec does not reap the guest process -- the same
  # lesson vm/dockerd-run.sh records.
  seu_exec 20 -u seu "$SANDBOX" -- pkill -f 'com.microsoft.playwright.CLI' >/dev/null 2>&1 || true
  printf '\n' >&2
}
