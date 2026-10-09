FROM ubuntu:26.04

# --- base tooling ---
# Install tools used by claude
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      git \
      ripgrep fd-find jq \
      bash bash-completion less procps psmisc \
      unzip xz-utils zip \
      build-essential python3 python3-venv \
      locales \
 && sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen && locale-gen
# --- base tooling (end) ---

# --- docker ---
# Add Docker's official GPG key:
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
RUN tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

# Install
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
 && docker --version
# --- docker (end) ---

# --- Claude Code ---
ARG CLAUDE_CODE_VERSION=2.1.292
RUN curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION} \
 && install -m 0755 "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude \
 && rm -rf /root/.local/bin/claude /root/.local/share/claude \
 && claude --version

# CC Status line
ARG CCSTATUSLINE_VERSION=2.2.29
RUN apt-get update && apt-get install -y --no-install-recommends nodejs \
 && mkdir -p /opt/ccstatusline \
 && curl -fsSL "https://registry.npmjs.org/ccstatusline/-/ccstatusline-${CCSTATUSLINE_VERSION}.tgz" \
      | tar -xz -C /opt/ccstatusline --strip-components=1 \
 && test -s /opt/ccstatusline/dist/ccstatusline.js \
 && printf '#!/bin/sh\nexec /usr/bin/node /opt/ccstatusline/dist/ccstatusline.js "$@"\n' \
      > /usr/local/bin/ccstatusline \
 && chmod 0755 /usr/local/bin/ccstatusline \
 && ccstatusline --version
# --- Claude Code (end) ---

# --- Mise ---
ARG MISE_VERSION=v2026.10.3
RUN curl -fsSL https://mise.run | MISE_VERSION=${MISE_VERSION} MISE_INSTALL_PATH=/usr/local/bin/mise sh \
 && mise --version
# --- Mise (end) ---

# --- User ---
# Everything of seu's lives in its home, and only the home is persisted: the
# SEU's named volume is mounted over /home/seu. /src is the host worktree
# (read-only), ~/work the git clone of it, ~/.m2, ~/.cache and ~/.local/share
# the caches, ~/.local/share/docker the pulled images.
#
# The volume mounts EMPTY and root-owned the first time, hiding whatever the
# image has at /home/seu. So the home is prepared here and kept as a skeleton in
# /opt/seu/home-skel, which seu-home-init copies into a fresh volume. The
# directories are created up front, owned by seu: dockerd (root) creates its
# data root with `mkdir -p`, and a root-owned ~/.local/share would lock mise out.
RUN useradd --create-home --shell /bin/bash seu \
 && usermod -aG docker seu \
 && mkdir -p /home/seu/work /home/seu/.m2 /home/seu/.cache /home/seu/.config /home/seu/.local/share /home/seu/.claude
RUN chown -R seu:seu /home/seu \
 && mkdir -p /opt/seu \
 && cp -a /home/seu /opt/seu/home-skel
# --- User (end) ---

# --- Playwright browsers ---
# Downloaded here, by the host's docker build, instead of in the install
# sandbox: the downloads are large and kept failing there with ECONNRESET, and
# every template rebuild repeated them.
#
# Into the home skeleton, so seu-home-init copies them into ~/.cache/ms-playwright
# on the volume, where Playwright looks by default. On the volume rather than
# behind PLAYWRIGHT_BROWSERS_PATH in the image, so a project whose Playwright
# version differs can still `install` its own browsers and keep them.
#
# PLAYWRIGHT_VERSION must match the project's Playwright Java client: the
# browser builds are per version, and a mismatch means the project's version
# finds nothing here. --with-deps also installs the OS libraries, which needs
# root and so cannot happen in the install sandbox either.
#
# playwright-core, fetched as a tarball the way ccstatusline is above, because
# Ubuntu's `nodejs` package carries no npm. It stays in the image: the browsers
# are registered against its path in .links, and a later `install` deletes
# browsers whose registering package no longer exists.
ARG PLAYWRIGHT_VERSION=1.63.0
ARG PLAYWRIGHT_BROWSERS="chromium firefox"
RUN mkdir -p /opt/playwright-core \
 && curl -fsSL "https://registry.npmjs.org/playwright-core/-/playwright-core-${PLAYWRIGHT_VERSION}.tgz" \
      | tar -xz -C /opt/playwright-core --strip-components=1 \
 && apt-get update \
 && PLAYWRIGHT_BROWSERS_PATH=/opt/seu/home-skel/.cache/ms-playwright \
      node /opt/playwright-core/cli.js install --with-deps ${PLAYWRIGHT_BROWSERS} \
 && chown -R seu:seu /opt/seu/home-skel/.cache \
 && rm -rf /var/lib/apt/lists/*
# --- Playwright browsers (end) ---

# --- Docker storage ---
# Pulled images in the home volume, so they survive a restart and are part of
# the template every SEU is cloned from. In daemon.json rather than a dockerd
# flag, so any dockerd started in this image uses it.
RUN mkdir -p /etc/docker \
 && printf '{\n  "data-root": "/home/seu/.local/share/docker"\n}\n' > /etc/docker/daemon.json
# --- Docker storage (end) ---

# --- Scripts ---
COPY seu-home-init.sh dockerd-run.sh session-init.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/seu-home-init.sh /usr/local/bin/dockerd-run.sh /usr/local/bin/session-init.sh
# --- Scripts (end) ---

# --- Environment variables ---
# mise's data, config and cache in the home, explicitly: `seu start` writes the
# project's mise.toml to $MISE_CONFIG_DIR. The shims on PATH rather than
# `mise activate`, because an exec from the host is not an interactive shell.
# A login shell's /etc/profile may reset PATH, so profile.d repeats it.
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: otherwise `Playwright.create()` installs
# every browser, which fails offline in the session for any it does not have.
ENV MISE_DATA_DIR=/home/seu/.local/share/mise \
    MISE_CONFIG_DIR=/home/seu/.config/mise \
    MISE_CACHE_DIR=/home/seu/.cache/mise \
    PATH=/home/seu/.local/share/mise/shims:$PATH \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/home/seu/.claude \
    DOCKER_HOST=unix:///var/run/docker.sock \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    LANG=en_US.UTF-8
RUN printf 'PATH="/home/seu/.local/share/mise/shims:$PATH"\n' > /etc/profile.d/10-mise.sh
# --- Environment variables (end) ---

USER seu
WORKDIR /home/seu

CMD ["/bin/bash", "--login"]
