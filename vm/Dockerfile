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
RUN useradd --create-home --shell /bin/bash seu \
 && usermod -aG docker seu \
 && mkdir -p /seu/work /seu/m2 /seu/cache /seu/docker /seu/mise /home/seu/.claude \
 && ln -s /seu/work  /work \
 && ln -s /seu/m2    /home/seu/.m2 \
 && ln -s /seu/cache /home/seu/.cache \
 && chown -R seu:seu /home/seu /seu \
 && chown -h seu:seu /work /home/seu/.m2 /home/seu/.cache
# --- User (end) ---

# --- Environment variables ---
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/home/seu/.claude \
    DOCKER_HOST=unix:///var/run/docker.sock \
    LANG=en_US.UTF-8
# --- Environment variables (end) ---

USER seu
WORKDIR /home/seu

CMD ["/bin/bash", "--login"]
