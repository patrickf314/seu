#!/bin/sh
# Run dockerd in the FOREGROUND. Invoked as root by a host-side background
# `msb exec`, which is the process that supervises it for the VM's lifetime.
set -eu

mkdir -p /var/log /var/run
mountpoint -q /sys/fs/cgroup || mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null || true

DRIVER="${SEU_DOCKER_STORAGE_DRIVER:-overlay2}"

exec dockerd \
  --storage-driver "$DRIVER" \
  --host unix:///var/run/docker.sock \
  --iptables=true \
  --log-level warn \
  >>/var/log/dockerd.log 2>&1
