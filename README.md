# SEU — Claude Code in an isolated microVM, with the full project toolchain

Runs Claude Code inside a hardware-isolated microVM on your Mac, with this
worktree mounted **read-only** and network egress restricted to Anthropic.
Unlike a plain sandbox, the VM has a complete working toolchain — Java, Maven,
Node, pnpm and a **real Docker daemon** — so `mvn verify`, Testcontainers and
`test/docker-compose.yml` all work with no network at all.

Built on [microsandbox](https://docs.microsandbox.dev) (libkrun +
Hypervisor.framework). Each session is a real VM with its own Linux kernel.

Grew out of one project and is being generalized: what is repository-specific
now lives in a `.seu/config.conf` profile inside that repository. The warm-up
(`vm/warm.sh`) and the base image are still Maven/Node-shaped — that is the next
piece to move out.

## Requirements

- macOS on Apple Silicon (microsandbox does not support Intel)
- `msb` (microsandbox) installed at `~/.microsandbox/bin/msb`
- Docker on the host — for `seu build` only; sessions never touch it
- Artifact-repository credentials for whatever the project needs, either in
  `~/.m2/settings.xml` or as `GITHUB_ACTOR` / `GITHUB_TOKEN`

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
./seu/bin/seu port 8080   # forward a host port into the VM, docker-style
./seu/bin/seu clean       # remove the VM (add --volumes to drop the caches too)
```

`build` takes `--with-images` (also produce the project's application images,
which the test compose file needs — slower, a lot more disk), `--rebuild`,
`--no-host-m2`, `--no-host-images` and `--refresh-images`.

Your Claude Code settings, your `ccstatusline` layout and your login are carried
into the VM on every `start`/`shell` — see
[Your Claude Code setup follows you in](#your-claude-code-setup-follows-you-in).

Inside the VM:

- `/src` is this worktree, **read-only**. Writes fail at the kernel level.
- `/work` is a full git clone of it, writable, living in a named volume.
  Uncommitted changes from `/src` are carried over. Run `claude` here.
- Docker is a real in-VM daemon. The host's Docker socket is never exposed —
  that would hand any process in the sandbox root on your Mac.

## The project profile

What is specific to one repository lives in `.seu/config.conf` **in that
repository**, not in seu:

```ini
image_name  = seu-vm-website-react     # default: seu-vm-<worktree-name>
mise_config = mise.toml                # optional; copied into the base image

maven_server = devx-repository         # repeatable
maven_server = ui-test-components-repository

prepull = postgres:18                  # repeatable
prepull = nginx:latest
```

`key = value`, one per line, `#` for a full-line comment, a repeated key builds
a list. seu **parses** this file with awk — it never sources or evaluates it, and
every value that reaches a host command is validated first. The repository seu
sandboxes is not a repository seu trusts.

Every key is optional. Without the file a project still builds; it just gets no
prepulled images and no managed toolchain. `seu doctor` prints what it resolved
and warns about keys it does not recognise.

`examples/website-react.config.conf` is the profile for the project this grew out
of.

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

## Borrowing the host's Maven repository

`seu build` used to download a Maven world you already have. It now mounts
`~/.m2/repository` **read-only at `/host-m2` in the build sandbox** and declares
it as a `file://` repository, first in the resolution order.

It is a resolution *source*, not a seed. Copying is not an option — the
repository here is 139 GB against a 100 GB volume, and virtiofs is slow enough
that a bulk copy would lose to a plain download. As a `file://` remote, Maven
takes exactly the artifacts this project needs and **copies them into
`/seu/m2`**, so the session stays self-contained with no host mount. Anything
`/host-m2` cannot serve falls through to the real remotes as before.

Snapshots are deliberately disabled against it: a local repository holds
`maven-metadata-<repoid>.xml`, not the remote layout that snapshot and
version-range resolution need.

`--no-host-m2` (or `SEU_USE_HOST_M2=0`) turns it off.

### Artifacts the warm-up never gets asked for — `warm_artifact`

Two kinds of artifact never get fetched by the warm-up on its own.

**Plugins invoked from the command line.** `dependency:go-offline` and
`dependency:resolve-plugins` only consider plugins *bound in the POM*. A goal run
as `mvn failsafe:integration-test` reports as `default-cli` in its errors, and
neither it nor its dependency graph is visible to any pre-fetch goal.

**Artifacts nothing declares.** Surefire and failsafe pick their provider jar,
`org.apache.maven.surefire:surefire-junit-platform`, from the test framework they
detect at runtime. It is a declared dependency of nothing. Same for a JDBC driver
named in a config string, or a service-loader-selected annotation processor.

Name the coordinates and let Maven resolve them properly:

```ini
warm_artifact = org.apache.maven.plugins:maven-failsafe-plugin:3.5.6
warm_artifact = org.apache.maven.surefire:surefire-junit-platform:3.5.6
```

The warm-up runs `dependency:get` on each, which pulls descriptors, parents and
transitives — against `/host-m2` first, so it is nearly free.

Resolution is what makes this work, and why an earlier file-copy mechanism was
removed: copying `org/codehaus/plexus/plexus-java/1.5.2` brings the jar and its
own POM but not its parents, `plexus-languages` and `plexus`, which live under
different artifactId directories — and a descriptor read needs the whole chain.
The symptom is *"Failed to read artifact descriptor"*.

The version must match what the build actually uses. `dependency:get` will
happily resolve a stale one while the build asks for another.

### Why the tracking files are deleted afterwards

Maven records each artifact's origin in `_remote.repositories`, and in **offline**
mode it refuses an artifact whose recorded origin is not among the repositories
currently in play — the same *"has not been downloaded from it before"* failure
documented below for the surefire provider. Half the warmed repository now claims
to come from `seu-host-m2`, a `file://` URL that exists only inside the build
sandbox. The warm-up therefore deletes `_remote.repositories`, `*.lastUpdated`,
`resolver-status.properties` and `*.part*` before handing over, which makes Maven
treat everything as locally installed. This is not housekeeping; without it the
session cannot resolve.

### Playwright browsers

Browser binaries are per-platform, so there is nothing to reuse from the host —
those are macOS builds and the guest is linux-arm64. They are downloaded during
`seu build` into `~/.cache/ms-playwright`, which lives in the persistent volume.

```ini
playwright_pom     = club/club-ui/club-ui-test/pom.xml
playwright_browser = chromium
playwright_browser = firefox
```

`playwright_pom` names the module whose pom puts the Playwright client on the
classpath — that is all `exec:java -Dexec.mainClass=com.microsoft.playwright.CLI`
needs. Setting it is what enables the step; a project without Playwright omits
both keys and nothing runs.

It is stated, never guessed. Searching the poms for the dependency looks
attractive and gets the common case right, but misses an inherited dependency
from a parent or BOM — and the failure mode is silence now and an `ENOTFOUND` at
test time, in a session that can no longer fix it. `playwright_browser` without
`playwright_pom` is a hard error at preflight, not a warning after a 40-minute
warm-up.

**List every browser the suite launches.** The default is chromium alone.

This list is the only source of browsers, because the image sets
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Without that, `Playwright.create()` calls
`Driver.ensureDriverInstalled(env, installBrowsers=true)`, which runs the driver's
`install` with **no browser argument** — and a bare install means all three,
whatever the test actually uses. Offline that is a guaranteed `ENOTFOUND
cdn.playwright.dev` *before a browser is even chosen*, which reads like a network
bug and is really an implicit install nobody asked for. The warm-up's explicit
`CLI install <browsers>` is unaffected; the flag is only read on the `create()`
path.

With it off, a missing browser fails at launch with `Executable doesn't exist`,
which points at the real problem. The warm-up also checks
`~/.cache/ms-playwright` afterwards and warns per browser, so a silent no-op in
the install step cannot reach a session unnoticed.

### Playwright traces

```bash
seu playwright trace club/club-ui/club-ui-test/target/trace.zip
```

The path is relative to `/work` (a leading `/work/` is accepted). This starts
Playwright's own trace viewer **inside the VM**, forwards its port out with the
machinery behind `seu port`, and opens it in your browser. Ctrl-C stops the
viewer and drops the forward.

The trace never leaves the sandbox — only an HTTP port does. Your Mac needs no
node, no `npx` and no network, which also means there is no copy of the trace
sitting around on the host afterwards.

It uses the same `playwright_pom` as the browser download, because the viewer
ships inside the Playwright jar and that module's pom is what puts it on the
classpath. A project without the key gets a clear error rather than a confusing
Maven failure.

Two details worth knowing, both verified against the driver bundle rather than
assumed:

- `show-trace --host/--port` makes the driver *serve* the viewer instead of
  launching its bundled browser app. It still tries to open a browser tab in the
  guest, where there is none, but Playwright swallows that failure
  (`open(url).catch(() => {})`) and the server stays up.
- The server answers `/` with a **relative** redirect
  (`./trace/index.html?trace=…`), which the browser resolves against whatever
  origin it asked. So the forwarded `http://127.0.0.1:<port>/` carries the trace
  query along and nothing has to be rewritten for the port change.

## Reusing the host's Docker images

Every image listed under `prepull` that the host already has is `docker save`d
into **one** tar (so shared layers are stored once) in `.seu-state/`, mounted
read-only at `/host-images` in the build sandbox, and `docker load`ed before the
pull loop. The warm-up then pulls only what is genuinely missing.

The export is skipped when the images' ids have not changed since last time;
`--refresh-images` forces it, `--no-host-images` disables the whole mechanism.

**Only `arm64/linux` images are ever staged.** A wrong-architecture image is
reported and left to be pulled. This check is not optional: loading an amd64
image into the arm64 guest reproduces exactly the `exec format error` described
below, on a container whose architecture looks perfectly correct.

## Credentials

Artifact-repository credentials only — for the Anthropic login, see
[Copying the login](#copying-the-login).

`seu build` needs them; a session must not have them.

For each `maven_server` in the profile, the credentials are read from your
environment or `~/.m2/settings.xml` **on the host** and passed to the build
sandbox through `msb exec -e`, so they live only in that process's environment.
The `settings.xml` generated for the VM (`lib/maven-settings.py`) contains
`${env.SEU_MVN_<ID>_USER/_PASS}` placeholders, so no secret is **ever written to
disk inside the VM**.

That generated file reproduces your host repository configuration — mirrors,
plugin groups, proxies, profiles — rebuilt from understood pieces rather than
copied, so nothing travels that was not explicitly handled:

- `<properties>` inside profiles are **dropped**. That is where tokens hide.
- proxies keep host/port/nonProxyHosts; their credentials are dropped.
- `settings-security.xml` is never read, so a `{...}`-encrypted password cannot
  be decrypted. Such a server is reported and left without credentials.

When the warm-up finishes, `~/.m2/settings.xml` in the VM is replaced with one
that contains only `<offline>true</offline>`. Session builds then resolve from
the warmed repository and never attempt an authenticated fetch — and nothing in
it points at `/host-m2`, which the session cannot see anyway: the build sandbox
and every host mount it had are destroyed before the session sandbox is created.

**Known weakness:** `msb exec -e "KEY=secret"` puts the value in the host
process's argv, where any local process can read it with `ps`. This predates the
change above and now applies to one variable per server. `msb create
--secret-conf` is the candidate fix.

**Consequence:** adding a *new* dependency does not work inside a session. Add it
on the host and re-run `seu build`.

## Your Claude Code setup follows you in

A sandbox you have to re-configure is a sandbox you stop using. Every `seu
start` and `seu shell` projects your host configuration into the VM, so there is
nothing to set up in there and nothing to log in to:

| on your Mac | in the VM | what happens to it |
| --- | --- | --- |
| `~/.claude/settings.json` | `~/.claude/settings.json` | host-only keys dropped, `vm/claude-settings.json` merged **on top** |
| `~/.config/ccstatusline/settings.json` | same path | an `SEU <worktree>` badge is prepended to the first line |
| `~/.claude.json` | same path | only the account and onboarding keys, **merged** into what the VM already has |
| login Keychain, `Claude Code-credentials` | `~/.claude/.credentials.json` | the OAuth tokens, so `/login` is never needed |

At **start** time, not baked into the image: changing a setting then costs
nothing, where a baked copy would cost a full `seu build`. `lib/claude-config.py`
does the projecting on the host; nothing is sourced or executed from either side.

`SEU_SYNC_CLAUDE=0` turns all of it off and leaves the image's own
`vm/claude-settings.json` in place. `SEU_SYNC_AUTH=0` keeps the settings but not
the login.

### What does not cross, and why

- **`hooks`.** Yours shell out to `alerter`, which exists on macOS and not in a
  Debian guest; every notification would do nothing but log a missing command.
- **`installMethod`, `autoUpdaterStatus`, `apiKeyHelper`, `awsAuthRefresh`,
  `otelHeadersHelper`, `forceLoginMethod`.** All of them describe the host
  install or shell out to host-only tooling.
- **Everything else in `~/.claude.json`.** It is ~90 keys of cached feature
  flags, Statsig gates, tip counters and per-directory project state. The
  account identity and the "you have already been through this" flags are the
  only parts that mean anything in a fresh VM; `githubRepoPaths` and `projects`
  are host filesystem layout.
- **`statusLine.command`.** Replaced, not copied: on the host it may be an
  absolute mise shim path that does not exist in the guest.

The merge direction matters. Your settings are the *base* and
`vm/claude-settings.json` goes **on top**, so the sandbox's own hardening always
wins — a host `permissions.allow` can never re-open `Read(/src/**)`. Lists are
unioned rather than replaced, so your `permissions.deny` entries survive
alongside seu's.

### The status line

`ccstatusline` is in the base image as a pinned tarball under
`/opt/ccstatusline`, run by Debian's `nodejs` rather than the project's
mise-managed one — it has to keep working whatever node the project pins, or
whether it pins one at all. mise's shims come first on `PATH`, so this stays
invisible to the project. There is no npm in the image and a session has no
egress to reach one, which is also why the generated config declares
`installation.method = "pinned"`: nothing will offer to update itself in a
session that could never do it.

Your layout is reproduced as-is, with one addition: a bold green `SEU
<worktree>` badge as the first widget. The one thing that must never be
ambiguous is whether a terminal is inside the sandbox or on your Mac.

### Copying the login

macOS keeps the Claude Code tokens in the login Keychain; Linux keeps them in
`$CLAUDE_CONFIG_DIR/.credentials.json`. Reading the one and writing the other is
the whole of it — there is no login flow to replay, and `/login` inside the VM
would want a browser the guest does not have.

The first `seu start` after this raises a Keychain prompt. **Always Allow** and
it never asks again; a denied prompt is not an error, the session just starts
logged out.

Three things are deliberate here:

- **The copy lives on the sandbox's root disk**, never in the `/seu` volume and
  never in the image. The root disk is re-created from the image whenever the
  sandbox is, which is exactly the lifetime a copied credential should have.
  `seu clean` takes it with it.
- **The newer token wins.** Host and guest refresh independently, so by the
  second start the guest's copy may well be the fresher one. The in-VM step
  compares `expiresAt` and keeps whichever lives longest, instead of clobbering
  a working session with a stale blob from the Keychain.
- **Claude cannot read its own token.** `vm/claude-settings.json` denies
  `Read(~/.claude/.credentials.json)`.

**Know what this trades away.** A session is no longer only as privileged as the
network policy allows — it holds a refresh token for your Anthropic account. The
microVM boundary and the deny-by-default egress are what stand behind that, and
`SEU_SYNC_AUTH=0` is there if you would rather it did not. Note also that
refresh tokens rotate: if a long VM session refreshes, the Keychain copy your
Mac is holding can go stale and you may have to `/login` on the host once.

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

## Ports

A dev server or a published container port inside the VM is reachable *in* the
VM but has no path to your Mac. `seu port` opens one:

```bash
seu port                      # list the active forwards
seu port 8080                 # shorthand for 8080:8080
seu port 80:80 8080:8080      # HOST:GUEST, like docker
seu port 0.0.0.0:8080:8080    # BIND:HOST:GUEST
seu port --stop 8080          # drop one; --stop-all drops every forward
```

The default bind is `127.0.0.1`, not `0.0.0.0`: forwarding a port out of a
sandbox should not also publish that sandbox to your local network. Ask for
`*:` or an explicit bind address when you want that.

Forwards are SSH tunnels against the **running** sandbox (see the maintenance
note below for why they are not `msb create -p`), so ports can be added and
dropped at any time and nothing in the VM restarts. They do not survive
`seu stop` — `seu stop` and `seu clean` tear them down, so no `ssh -N` is ever
left holding a host port.

Forwards connect to **`localhost`** inside the VM, not to `127.0.0.1`. That
matters: a Vite dev server binds `[::1]` only, and an IPv4-literal destination
would come up fine and then refuse every connection. If a forward connects to
nothing, run `ss -lntp` in the VM and check what the process actually bound.

The first `seu port` generates `.seu-state/ssh/id_ed25519` and registers it with
`msb ssh authorize`. That key is seu's own; `~/.ssh` is never read or written,
and `-F /dev/null` keeps a personal `~/.ssh/config` from redirecting the tunnel.

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
- **`Playwright.create()` installs ALL browsers unless told not to.** It runs the
  driver's `install` with no browser argument — verified in
  `DriverJar.installBrowsers`, which holds the only `install` string in the class
  and no browser names at all. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in the image
  turns it off so `playwright_browser` is authoritative. `SELENIUM_REMOTE_URL`
  suppresses it too, per the same class.
- **Playwright needs two download hosts, not one.** The client alternates
  between `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`, so
  allowing only the first makes every other attempt die with `ENOTFOUND
  playwright.download.prss.microsoft.com`. (`*.azureedge.net` is the retired CDN,
  kept for older versions.) Verified by resolving both inside a sandbox created
  with `net-build.yaml` — which is also the quickest way to test any allowlist
  change: `msb create -n t --net-conf config/net-build.yaml alpine`, then
  `getent hosts <name>`. A blocked host returns NXDOMAIN.
- Pin the Claude Code version for reproducible images:
  `CLAUDE_CODE_VERSION=2.1.267 ./seu/bin/seu build --rebuild`.
- **A `file://` local repository is a valid Maven *remote* for releases only.**
  It carries `maven-metadata-<repoid>.xml`, not the remote-layout metadata that
  snapshot and version-range resolution read, so `/host-m2` is declared with
  `<snapshots><enabled>false</enabled></snapshots>` and as an additional
  repository rather than a mirror — anything it cannot serve must still fall
  through to the real remotes.
- **A file copy cannot substitute for resolution.** Copying an artifact brings
  its jar and its own POM, never its parent POMs, and a descriptor read needs the
  full parent chain — which usually lives under other artifactId directories.
  This is why `warm_artifact` names coordinates for `dependency:get` instead of
  copying paths out of `/host-m2`.
- **`dependency:go-offline` only sees plugins bound in the POM.** A goal invoked
  from the command line (`default-cli` in the error) is invisible to it, along
  with everything that goal needs.
- **Reflectively-resolved artifacts defeat every pre-fetch goal.** If a jar is
  chosen at runtime rather than declared in a POM — the surefire provider is the
  standing example — no goal can discover it. Either run the thing that needs it
  during the warm-up, or name it as a `warm_artifact`. The failure always
  surfaces later, offline, as a resolution error.
- **`_remote.repositories` is what breaks an offline handover.** An artifact
  resolved from `seu-host-m2` is unusable in the session, where that repository
  does not exist, until the tracking files are deleted. See above.
- `msb create --copy-file HOST:GUEST` lands the file in the rootfs **before**
  boot, so it needs no agent and cannot race `seu_wait_agent`. Verified good for
  handing the generated `settings.xml` in.
- `-v SRC:DST:ro,uid=1000,gid=1000` works and does both things it claims:
  host-owned files appear as uid 1000 inside the guest, and a write to the mount
  is refused. **But the source must be a real path** — a `mktemp -d` path under
  `/var` fails at boot with `mount: Not a directory (os error 20)`, which is the
  same `pwd -P` trap as the source mounts.
- `docker save` now writes an **OCI archive** (`blobs/sha256/`, `index.json`),
  not the old layout. It still carries `manifest.json` with `RepoTags`, so
  `docker load` restores the tags and `docker image inspect <ref>` finds them.
- The host's project-specific bits live in `<project>/.seu/config.conf` and are
  **parsed, never sourced**. Keep it that way: the whole point of seu is that the
  repository is not trusted, and a sourced config would hand it your Mac.
- **`msb create -p HOST:GUEST` exists, but ports are fixed at create time.**
  `msb modify` has no port flag at all — it only takes cpus, memory, disk, env,
  labels, workdir and secrets. Adding a port to a live sandbox with `-p` would
  therefore mean `msb create --replace`: root disk gone, dockerd and
  `session-init.sh` re-run, every running process killed. That is why `seu port`
  does not use it.
- **`msb ssh` carries SSH `direct-tcpip` channels into a running sandbox**, so
  plain OpenSSH `ssh -N -L` forwards a port with nothing restarted. The msb SSH
  server is `russh` built into the binary, not an sshd in the guest;
  `msb ssh serve --stdio <sandbox>` serves one transport over stdin/stdout,
  which is exactly a `ProxyCommand`. Verified end to end against a live sandbox.
  - `msb ssh serve` refuses to start without an authorized public key
    (*"SSH server has no authorized public keys"*), unlike `msb ssh connect`,
    which uses an internal identity. `msb ssh authorize --file <key>.pub` is
    idempotent and writes to `~/.microsandbox/ssh/authorized_keys`.
  - The username is not checked; the guest-side destination `127.0.0.1` is
    accepted. Pass `--no-inactivity-timeout` or an idle tunnel is dropped.
  - **Forward to `localhost` in the guest, never the `127.0.0.1` literal.** A
    Vite dev server binds `[::1]` *only*, so an IPv4 literal destination finds
    nothing: the tunnel comes up and then refuses every connection, which looks
    like broken forwarding rather than a binding mismatch. `localhost` lets the
    guest resolver try both families and still reaches 127.0.0.1-only listeners
    (the trace viewer) and `0.0.0.0` ones (docker-proxy). Check with
    `ss -lntp` inside the VM when a forward connects to nothing.
  - **Check the host port *before* starting ssh.** Afterwards "something is
    listening on that port" cannot distinguish our tunnel from the squatter that
    made the bind fail, and a failed forward reads as a success. `ssh -o
    ExitOnForwardFailure=yes` makes the failure fast, but the race is in the
    readiness check, not in ssh.

## Layout

```
bin/seu                     dispatcher
lib/common.sh               identity, profile parsing, volumes, host mounts,
                            host-image export, dockerd supervision,
                            SSH plumbing, the port-forward registry and the
                            Claude config/credential sync
    cmd-*.sh                one file per command
    maven-settings.py       generates the in-VM settings.xml; extracts credentials
    claude-config.py        projects your ~/.claude setup onto the VM
vm/Dockerfile               base image: toolchain + docker + Claude Code + ccstatusline
   dockerd-run.sh           foreground dockerd (see notes above)
   session-init.sh          clone /src -> /work
   warm.sh                  the whole `seu build` warm-up
   claude-settings.json     the VM's own Claude settings, merged ON TOP of yours
config/net-session.yaml     Anthropic-only egress
       net-build.yaml       wide egress, build phase only
       resources.yaml       cpus / memory / idle timeout
examples/                   a real .seu/config.conf to copy into a project
.seu-state/                 git bundles, dockerd pidfiles, staged host images,
                            per-forward pidfiles under <slug>/ports/
                            (gitignored; override with SEU_STATE_DIR)
           ssh/             seu's own SSH key, shared by every project

<project>/.seu/config.conf  the per-project profile (see above)
```
