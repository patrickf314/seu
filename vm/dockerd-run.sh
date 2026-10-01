#!/bin/sh
# Run dockerd in the FOREGROUND. Invoked as root by a host-side background
# `msb exec`, which is the process that supervises it for the VM's lifetime.
#
# Why not a detached daemon or an --init handoff? Both were tried and neither
# works on microsandbox 0.7.2:
#   * `msb exec` never returns while any descendant lives -- even a bare
#     `setsid sleep 300 &` hangs it, and --timeout does not kill it. So a
#     fire-and-forget exec cannot start a daemon.
#   * `--init` takes PID 1 away from agentd, which then does NOT forward SIGTERM
#     to the handoff init. `msb stop` hangs in `draining` forever and the VM has
#     to be killed from the host.
# Keeping agentd as PID 1 and holding dockerd in a foreground exec gives us
# instant, clean `msb stop` / `msb start`.
set -eu

mkdir -p /var/log /var/run
mountpoint -q /sys/fs/cgroup || mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null || true

# Bootstrap the single named volume. /work, ~/.m2 and ~/.cache are symlinks into
# /seu (see vm/Dockerfile); they dangle until these directories exist. This runs
# as root before anything else touches the volume, so it is the natural place.
mkdir -p /seu/work /seu/m2 /seu/cache /seu/docker
chown seu:seu /seu /seu/work /seu/m2 /seu/cache

# overlay2 on the ext4 named volume is the verified-good combination. The
# fallbacks exist for a kernel or volume that cannot support it.
DRIVER="${SEU_DOCKER_STORAGE_DRIVER:-overlay2}"

exec dockerd \
  --data-root /seu/docker \
  --storage-driver "$DRIVER" \
  --host unix:///var/run/docker.sock \
  --iptables=true \
  --log-level warn \
  >>/var/log/dockerd.log 2>&1
