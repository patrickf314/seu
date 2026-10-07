FROM jdxcode/mise:debian

# --- base tooling ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release \
      git openssh-client \
      ripgrep fd-find jq \
      bash bash-completion less vim nano procps psmisc \
      unzip xz-utils zip \
      iproute2 iptables uidmap fuse-overlayfs \
      build-essential python3 python3-venv \
      locales \
 && sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen && locale-gen

# --- docker ---
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# --- Claude Code ---
ARG CLAUDE_VERSION
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && install -m 0755 "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude \
 && rm -rf /root/.local/bin/claude /root/.local/share/claude \
 && /usr/local/bin/claude --version

# --- ccstatusline
ARG CCSTATUSLINE_VERSION=2.2.29
RUN apt-get update && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/ccstatusline \
 && curl -fsSL "https://registry.npmjs.org/ccstatusline/-/ccstatusline-${CCSTATUSLINE_VERSION}.tgz" \
      | tar -xz -C /opt/ccstatusline --strip-components=1 \
 && test -s /opt/ccstatusline/dist/ccstatusline.js \
 && printf '#!/bin/sh\nexec /usr/bin/node /opt/ccstatusline/dist/ccstatusline.js "$@"\n' \
      > /usr/local/bin/ccstatusline \
 && chmod 0755 /usr/local/bin/ccstatusline \
 && /usr/local/bin/ccstatusline --version

# --- Playwright's browser system dependencies ---
# `install-deps` is an apt-get install: it needs root, and it writes outside
# /seu. That makes it impossible from `install.script` -- which runs as `seu`,
# in a sandbox whose rootfs is destroyed afterwards -- on two counts, and the
# `sudo` password prompt is only the first one you hit. It belongs here, where
# it runs once as root and every sandbox of this image inherits it.
#
# Playwright's own CLI rather than a hand-written package list: the names drift
# per Debian release -- the t64 ABI transition renamed half of them -- and the
# driver is the thing that knows which ones this version actually needs.
#
# playwright-core, fetched as a tarball the way ccstatusline is above, for two
# reasons: Debian's `nodejs` package carries no npm, so there is no npx; and the
# full `playwright` package downloads BROWSER BINARIES on install. Those are
# per-project, they are a download the session cannot repeat, and they belong in
# ~/.cache/ms-playwright on the named volume -- which is what `install.script`
# is for. Only the OS libraries are baked in here.
ARG PLAYWRIGHT_VERSION=1.63.0
ARG PLAYWRIGHT_BROWSERS="chromium firefox"
RUN mkdir -p /opt/playwright-core \
 && curl -fsSL "https://registry.npmjs.org/playwright-core/-/playwright-core-${PLAYWRIGHT_VERSION}.tgz" \
      | tar -xz -C /opt/playwright-core --strip-components=1 \
 && apt-get update \
 && node /opt/playwright-core/cli.js install-deps ${PLAYWRIGHT_BROWSERS} \
 && rm -rf /opt/playwright-core /var/lib/apt/lists/*

# --- the user
RUN useradd --create-home --shell /bin/bash --uid 1000 seu \
 && usermod -aG docker seu \
 && mkdir -p /seu/work /seu/m2 /seu/cache /seu/docker /seu/mise /home/seu/.claude \
 && ln -s /seu/work  /work \
 && ln -s /seu/m2    /home/seu/.m2 \
 && ln -s /seu/cache /home/seu/.cache \
 && chown -R seu:seu /home/seu /seu \
 && chown -h seu:seu /work /home/seu/.m2 /home/seu/.cache

# --- the toolchain
# Only mise itself is in the image (it comes with the base). The project's
# mise.toml is installed by `seu start` into the TEMPLATE volume -- see
# src/cmd/start/toolchain.ts -- so every project shares this image, and its
# tools live under /seu/mise, which is part of the volume every SEU is cloned
# from.
#
# Debian's /etc/profile assigns PATH outright, so a LOGIN shell -- `seu shell`,
# and every `bash -lc` seu runs -- throws away the ENV PATH set below. profile.d
# is sourced after that assignment, which is why the toolchain needs both.
RUN printf 'PATH="/seu/mise/shims:$PATH"\n' > /etc/profile.d/10-mise.sh

COPY dockerd-run.sh session-init.sh /usr/local/bin/
COPY --chown=seu:seu claude-settings.json /home/seu/.claude/settings.json
RUN chmod 0755 /usr/local/bin/dockerd-run.sh \
                /usr/local/bin/session-init.sh

USER seu
WORKDIR /home/seu

# The mise shims on PATH rather than `mise activate` in a profile: an exec from
# the host (`seu build`'s pre-install, every `msb exec`) is not an interactive
# shell, and without this a plain `mvn` there is "command not found".
#
# mise's data and config in the volume rather than the base's /mise: that is
# what makes the template's install survive into its clones. The cache in ~
# (also the volume), so it is `seu`'s and not root's.
#
# Auto-update would fight the pinned install and needs egress.
ENV PATH=/seu/mise/shims:$PATH \
    MISE_DATA_DIR=/seu/mise \
    MISE_CONFIG_DIR=/seu/mise \
    MISE_CACHE_DIR=/home/seu/.cache/mise \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/home/seu/.claude \
    DOCKER_HOST=unix:///var/run/docker.sock \
    LANG=en_US.UTF-8 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

CMD ["/bin/bash", "--login"]
