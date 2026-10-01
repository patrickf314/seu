# SEU — Claude Code in an isolated microVM, with the full project toolchain

Runs Claude Code inside a hardware-isolated microVM on your Mac, with this
worktree mounted **read-only** and network egress restricted to Anthropic.
Unlike a plain sandbox, the VM has a complete working toolchain — Java, Maven,
Node, pnpm and a **real Docker daemon** — so `mvn verify`, Testcontainers and
`test/docker-compose.yml` all work with no network at all.

Built on [microsandbox](https://docs.microsandbox.dev) (libkrun +
Hypervisor.framework). Each session is a real VM with its own Linux kernel.

This is a project-local proof of concept. The generic parts are meant to move
back into `~/Projekte/seu` later.

## Requirements

- macOS on Apple Silicon (microsandbox does not support Intel)
- `msb` (microsandbox) installed at `~/.microsandbox/bin/msb`
- Docker on the host — for `seu build` only; sessions never touch it
- GitHub Packages credentials, either in `~/.m2/settings.xml` (the setup the
  project README documents) or as `GITHUB_ACTOR` / `GITHUB_TOKEN`

## Use

```bash
git worktree add ../website-react-foo feature/foo
cd ../website-react-foo

./seu/bin/seu doctor      # check the host is ready
./seu/bin/seu build       # once per worktree; downloads everything, then opens a shell
```

Afterwards:

```bash
./seu/bin/seu shell       # new shell in the VM (starts it if stopped)
./seu/bin/seu stop        # suspend; /work and all caches persist
./seu/bin/seu start       # resume
./seu/bin/seu status      # VM, toolchain, docker, disk, git state
./seu/bin/seu pull        # fetch the VM's commits back as a git remote
./seu/bin/seu clean       # remove the VM (add --volumes to drop the caches too)
```

Add `--with-images` to `build` to also produce the `tsv-neubiberg/*` application
images, which `test/docker-compose.yml` needs. It is slower and uses a lot more
disk, so it is off by default.

Inside the VM:

- `/src` is this worktree, **read-only**. Writes fail at the kernel level.
- `/work` is a full git clone of it, writable, living in a named volume.
  Uncommitted changes from `/src` are carried over. Run `claude` here.
- Docker is a real in-VM daemon. The host's Docker socket is never exposed —
  that would hand any process in the sandbox root on your Mac.

## How `seu build` works, and why it is two sandboxes

The session must have almost no network. The warm-up needs a lot of it. And
**`msb modify` cannot change a sandbox's network policy** — so one sandbox
cannot be both.

`seu build` therefore creates a *throwaway* build sandbox with wide egress
(`config/net-build.yaml`), fills four **named volumes**, and destroys it. The
session sandbox is then created with the locked-down profile
(`config/net-session.yaml`) and mounts those same volumes.

Only **one** named volume survives that handoff, `seu-<slug>-data`, mounted at
`/seu`. microsandbox permits at most **two** managed additional disks per sandbox
— a third fails with *"managed additional disk has an invalid or reserved device
id"* — and one volume lets space float between the Docker image store and the
Maven repository instead of being partitioned up front.

Symlinks baked into `vm/Dockerfile` point the well-known paths into it:

| Path | Target | Holds |
|---|---|---|
| `/work` | `/seu/work` | the clone and every `target/` |
| `/home/seu/.m2` | `/seu/m2` | Maven repository |
| `/home/seu/.cache` | `/seu/cache` | pnpm store, Playwright browsers |
| `dockerd --data-root` | `/seu/docker` | pre-pulled images, overlay2 |

Because those are symlinks, `du -sh ~/.m2` and `find /work` report nothing
useful — measure `/seu/m2` and `/seu/work` instead.

**This is why every `apt-get install` lives in `vm/Dockerfile`** and not in a
warm-up step — including Playwright's Chromium dependencies, which CI installs
at test time via `mvn exec:java -Dexec.args="install-deps"`. Anything written
outside `/seu` during the warm-up is thrown away with the build sandbox.

It is a `--kind disk` (ext4) volume, not a directory volume: overlay2 cannot use
a virtiofs mount (`failed to mount overlay: invalid argument`), and a Maven
repository on virtiofs is painfully slow.

## The GitHub token

`seu build` needs it; a session must not have it.

The token is read from your environment or `~/.m2/settings.xml` on the host and
passed to the build sandbox through `msb exec -e`, so it lives only in that
process's environment. `.github/maven-settings.xml` reads it via `${env.*}`, so
it is **never written to disk inside the VM**.

When the warm-up finishes, `~/.m2/settings.xml` in the VM is replaced with one
that contains only `<offline>true</offline>`. Session builds then resolve from
the warmed repository and never attempt an authenticated fetch.

**Consequence:** adding a *new* dependency does not work inside a session. Add it
on the host and re-run `seu build`.

## Network

`config/net-session.yaml` is deny-by-default and allows only `api.anthropic.com`,
`claude.ai`, `claude.com`, `platform.claude.com` and `downloads.claude.ai` —
including the OAuth hosts Anthropic's own devcontainer `init-firewall.sh` omits,
without which `/login` and token refresh fail. Blocked hosts get `NXDOMAIN`.

Egress filtering applies at the VM boundary only. **Traffic that never leaves the
guest is untouched** — the Docker bridge, published container ports on
`localhost`, container-to-container DNS, Testcontainers. That is why the test-env
works under a deny-all policy.

`config/net-build.yaml` is the wider profile used only by `seu build`. It is
deliberately **not** `strict` and has TLS interception **off**: interception
would require importing microsandbox's CA into the JDK truststore, because the
JVM ignores the OS trust store and Maven would fail every HTTPS fetch.

## Getting work out

`seu pull` uses `git bundle` — real git objects carried over microsandbox's file
copy channel. No network path, no SSH keys, no writable host mount. The bundle
lands in `.seu-state/` and is wired up as an ordinary git remote, so `git log`,
`git diff` and `git merge` all work as usual.

Because worktrees of one repository share a ref namespace, the remote is named
after the worktree (`seu-website-react-foo`). Override with `SEU_REMOTE=name`.

## Worktrees

A worktree's `.git` is a *file* holding an absolute host path to the shared git
directory. `seu` detects this (`git rev-parse --git-common-dir`) and additionally
mounts that directory read-only **at the same absolute path it has on the host**,
so the pointer resolves unchanged. Nothing is rewritten.

If that mount were missing, the clone would silently have no history and
`seu pull` would find nothing to bundle — so `session-init.sh` fails loudly
instead.

## What this protects, and what it does not

**Does:** a separate kernel and virtualized hardware; a read-only view of your
source that cannot be written to; no writable host mount; default-deny egress;
no access to host Docker. Code run in the VM cannot modify your worktree or reach
the network beyond Anthropic.

**Does not:** protect you after you merge. Read the diff. microsandbox describes
itself as beta software — treat this as a strong speed bump, not a guarantee,
against genuinely hostile code.

## Notes for future maintenance

Hard-won, verified on microsandbox 0.7.2 / macOS 26.7 / arm64:

- **`msb exec` never returns while any descendant process lives.** Even a bare
  `setsid sleep 300 </dev/null >/dev/null 2>&1 &` hangs it, and `--timeout` does
  *not* kill it. A daemon cannot be started from a fire-and-forget exec.
- **Do not use `--init`.** Handing PID 1 to your own init takes it away from
  agentd, which then does **not** forward SIGTERM to it — a shutdown trap never
  fires, `msb stop` hangs in `draining` forever, and the VM must be killed from
  the host. `--init auto` additionally finds nothing in most images (it probes
  distro paths like `/sbin/openrc`).
  Consequently **dockerd runs in the foreground of a detached host-side
  `msb exec`** whose PID is kept in `.seu-state/<slug>/dockerd-exec.pid`. With
  agentd left as PID 1, `msb stop`/`msb start` are instant and clean.
- **`msb exec --timeout` does nothing.** It neither returns nor kills the command
  when the budget expires. `lib/common.sh` therefore wraps every bounded exec in
  a host-side watchdog (`seu_with_timeout`, returns 124 like GNU `timeout`, which
  macOS does not ship).
- **`msb create` and `msb start` return before agentd can serve execs**, and an
  exec issued in that window hangs *forever*. `msb ping` is no help — it exits
  non-zero even for a reachable sandbox. `seu_wait_agent` polls with a real,
  bounded exec instead, and must run after every create/start.
- **At most two managed additional disks per sandbox.** A third fails with
  "managed additional disk has an invalid or reserved device id". Hence the
  single `/seu` volume.
- `--mount-named` needs the full spec `NAME:DEST:kind=disk,size=20G` every time.
  It defaults to `kind=dir` and fails with "already exists as disk, but this
  sandbox requested dir"; a size that disagrees with the volume is rejected with
  the same confusing device-id error.
- The image's `WORKDIR` must exist at create time — msb validates it. It cannot
  be `/work`, because that symlink points into the not-yet-populated volume.
  Sessions get there via `msb exec -w /work` after the bootstrap.
- `msb exec` buffers all output until the command exits, so a long warm-up looks
  hung from the outside. It is not.
- dockerd occasionally loses its own startup race on a cold VM and dies with
  "failed to start containerd: timeout waiting for containerd to start".
  `seu_start_dockerd` retries up to three times.
- A *failed* `msb create` still registers the sandbox name, so always pass
  `--replace`.
- `msb load` reads a `docker save` stream on stdin and takes `-t`.
  `msb copy` addresses a sandbox path as `SANDBOX:/abs/path`.
- The guest kernel is 6.12.109 and has everything dockerd needs compiled in:
  overlayfs, veth, bridge, br_netfilter, nf_tables/iptables + nat, nf_conntrack,
  cgroup2, fuse. `docker info` reports `overlay2` on `extfs`, cgroup v2.
- microsandbox was rewritten between 0.2 and 0.7. **Ignore every tutorial
  online** — `msb server`, `Sandboxfile`, `msb init/add/up` and `--scope` do not
  exist.
- Invoke `~/.microsandbox/bin/msb` directly; it resolves libkrunfw relative to
  its own path and does not follow the `~/.local/bin/msb` symlink.
- Mount sources must be real paths (`pwd -P`); `/tmp` is a symlink on macOS.
- In the yaml configs `policy:` only accepts `none|public|open`; a non-empty
  `allow:` is what implies deny-by-default. `strict: true` requires
  `tls: {enabled: true}`.
- macOS ships bash 3.2: no `mapfile`, no associative arrays, and no heredocs
  inside `$(...)` — hence `lib/read-maven-credentials.py`.
- `mvn install` needs Docker **even with `-DskipTests -DskipImages`**, because
  `testcontainers-jooq-codegen-maven-plugin` starts a `postgres:18` container in
  `generate-sources` in every `*-db-adapter` module.
- **Docker Hub needs `*.docker.com`, not just `*.docker.io`.** The registry API
  is on `*.docker.io`, but image blobs redirect to a CDN under `docker.com` —
  `production.cloudfront.docker.com` (AWS) or `production.cloudflare.docker.com`.
  Allowing only the cloudflare one makes every pull fail with "lookup
  production.cloudfront.docker.com ... no such host", and the half-pulled images
  it leaves behind are *corrupt but cached*, which later surfaces as the
  baffling `exec /usr/local/bin/docker-entrypoint.sh: exec format error` on a
  container whose architecture is perfectly correct. `warm.sh` therefore aborts
  the build on any pull failure rather than warning.
- **surefire and failsafe resolve their provider jar at runtime**
  (`org.apache.maven.surefire:surefire-junit-platform`), and neither `install`
  nor `dependency:go-offline` fetches it. Without a real test run during the
  warm-up, the first `mvn test` in the offline session dies with "... has not
  been downloaded from it before". `warm.sh` runs the suite once to cache it.
- That warm-up run must be `mvn install`, **not `mvn test`**: a bare `mvn test`
  re-runs `generate-sources` without the upstream `-api` modules installed in
  that pass, and the `de.devx` react-client-api / assertj-assertion plugins abort
  with "No api models found".
- Pin the Claude Code version for reproducible images:
  `CLAUDE_CODE_VERSION=2.1.267 ./seu/bin/seu build --rebuild`.

## Layout

```
bin/seu                     dispatcher
lib/common.sh               identity, volumes, dockerd supervision
    cmd-*.sh                one file per command
    read-maven-credentials.py
vm/Dockerfile               base image: toolchain + docker + Claude Code
   dockerd-run.sh           foreground dockerd (see notes above)
   session-init.sh          clone /src -> /work
   warm.sh                  the whole `seu build` warm-up
   claude-settings.json     in-VM Claude settings
config/net-session.yaml     Anthropic-only egress
       net-build.yaml       wide egress, build phase only
       resources.yaml       cpus / memory / idle timeout
.seu-state/                 git bundles, dockerd pidfiles (gitignored)
```
