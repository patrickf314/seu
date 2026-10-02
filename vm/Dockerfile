# SEU base image.
#
# Built on the HOST with Docker (full network), then handed to microsandbox:
#   docker build -t seu-vm-website-react:<sha> . && docker save ... | msb load
# Docker is a build-time dependency only; sessions run as a microVM.
#
# IMPORTANT: only the /seu named volume (behind /work, ~/.m2, ~/.cache and
# dockerd's data-root) survives the build-sandbox -> session-sandbox handoff.
# Anything apt installs must therefore live HERE, not in a warm-up step -- it
# would be thrown away.
FROM debian:bookworm-slim

ARG CLAUDE_CODE_VERSION=
ARG DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- base tooling
# ripgrep is required by Claude Code; the rest is what makes a shell usable for
# real work. iptables is needed by dockerd for its NAT/DNAT rules.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release \
      git openssh-client \
      ripgrep fd-find jq \
      bash bash-completion less vim nano procps psmisc \
      unzip xz-utils zip \
      iproute2 iptables uidmap fuse-overlayfs \
      build-essential python3 python3-venv \
      locales \
 && sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------- docker
# Full docker-ce (daemon + CLI + compose + buildx). The daemon runs inside the
# microVM; the host Docker socket is never exposed to the sandbox.
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg \
      -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------- Playwright Chromium OS deps
# Replaces CI's `mvn exec:java -Dexec.args="install-deps"` (.github/workflows/
# build.yml), which cannot run at warm-up time because apt output would be
# discarded with the build sandbox. The browser BINARIES are downloaded during
# `seu build` into ~/.cache/ms-playwright, which is a persistent volume.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 libx11-xcb1 libxshmfence1 \
      fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------------ Claude Code
# From Anthropic's signed apt repo. Key fingerprint is verified after import.
RUN curl -fsSL https://downloads.claude.ai/keys/claude-code.asc \
      -o /etc/apt/keyrings/claude-code.asc \
 && gpg --show-keys --with-fingerprint --with-colons /etc/apt/keyrings/claude-code.asc \
      | grep -q '^fpr:::::::::31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE:' \
 && echo "deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/stable stable main" \
      > /etc/apt/sources.list.d/claude-code.list \
 && apt-get update \
 && if [ -n "$CLAUDE_CODE_VERSION" ]; then \
      apt-get install -y --no-install-recommends "claude-code=$CLAUDE_CODE_VERSION"; \
    else \
      apt-get install -y --no-install-recommends claude-code; \
    fi \
 && rm -rf /var/lib/apt/lists/*

# -------------------------------------------------------------------- the user
# Non-root is not cosmetic: Claude Code refuses to start with
# --dangerously-skip-permissions as root on Linux. Only dockerd runs as root.
# Everything that must survive lives in ONE named disk volume mounted at /seu
# (microsandbox permits at most two managed additional disks per sandbox). These
# symlinks point the well-known paths into it. The targets are created here too,
# so they resolve during the image build (mise writes to ~/.cache); at runtime the
# volume mount replaces /seu wholesale and dockerd-run.sh recreates the layout.
RUN useradd --create-home --shell /bin/bash --uid 1000 seu \
 && usermod -aG docker seu \
 && mkdir -p /seu/work /seu/m2 /seu/cache /seu/docker /home/seu/.claude \
 && ln -s /seu/work  /work \
 && ln -s /seu/m2    /home/seu/.m2 \
 && ln -s /seu/cache /home/seu/.cache \
 && chown -R seu:seu /home/seu /seu \
 && chown -h seu:seu /work /home/seu/.m2 /home/seu/.cache

# ------------------------------------------------------------- mise + toolchain
# The mise config is copied from the project by seu/lib/cmd-build.sh (see
# `mise_config` in .seu/config.conf), so the image toolchain always matches what
# the project's own build validates. A project without one gets an EMPTY file
# here, which is a valid "no managed toolchain" answer.
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh \
 && chmod 0755 /usr/local/bin/mise

COPY --chown=seu:seu mise.toml /home/seu/.config/mise/config.toml

USER seu
RUN mise trust --all \
 && mise install --yes \
 && mise reshim

# Resolve the toolchain paths now and bake them into a login profile. `msb exec`
# always attaches a LOGIN shell so /etc/profile.d is sourced; shims alone would
# not give Maven a JAVA_HOME.
USER root
RUN set -eu; \
    JH="$(su seu -lc 'mise where java' 2>/dev/null || true)"; \
    MH="$(su seu -lc 'mise where maven' 2>/dev/null || true)"; \
    { printf '%s\n' \
      '# SEU toolchain, generated at image build time from the project mise config' \
      'export MISE_DATA_DIR=/home/seu/.local/share/mise' \
      'export PATH="/home/seu/.local/share/mise/shims:$PATH"' \
      'export DOCKER_HOST=unix:///var/run/docker.sock' \
      'export PNPM_HOME=/home/seu/.cache/pnpm' \
      'export PLAYWRIGHT_BROWSERS_PATH=/home/seu/.cache/ms-playwright' \
      'export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1'; \
      if [ -n "$JH" ]; then printf 'export JAVA_HOME=%s\n' "$JH"; fi; \
      if [ -n "$MH" ]; then printf 'export MAVEN_HOME=%s\n' "$MH"; fi; \
    } > /etc/profile.d/10-seu-toolchain.sh; \
    chmod 0644 /etc/profile.d/10-seu-toolchain.sh

COPY dockerd-run.sh session-init.sh warm.sh /usr/local/bin/
COPY --chown=seu:seu claude-settings.json /home/seu/.claude/settings.json
RUN chmod 0755 /usr/local/bin/dockerd-run.sh \
                /usr/local/bin/session-init.sh \
                /usr/local/bin/warm.sh

USER seu
# NOT /work: that is a symlink into the /seu volume, which mounts empty, and msb
# validates the image's workdir at sandbox-create time -- when the target does
# not exist yet. Sessions get /work via `msb exec -w /work` after bootstrap.
WORKDIR /home/seu

# Auto-update would fight the pinned install and needs egress we do not grant.
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: `Playwright.create()` calls
# Driver.ensureDriverInstalled(env, installBrowsers=true), which runs the driver's
# `install` with NO browser argument -- and a bare install means ALL THREE
# browsers, whatever the test actually launches. In an offline session that is a
# guaranteed "ENOTFOUND cdn.playwright.dev" before a browser is even chosen.
# Switching it off makes `playwright_browser` the single source of truth; the
# warm-up's explicit `CLI install <browsers>` is unaffected, because the skip flag
# is only read on the create() path.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CLAUDE_CONFIG_DIR=/home/seu/.claude \
    DOCKER_HOST=unix:///var/run/docker.sock \
    LANG=en_US.UTF-8

CMD ["/bin/bash", "--login"]
