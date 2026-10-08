#!/bin/sh
# Make /home/seu usable. Runs as ROOT, before anything else touches the home;
# idempotent, so it runs on every start.
#
# /home/seu is the SEU's named volume, which mounts empty and root-owned the
# first time and hides the home the image prepared. That home is kept in
# /opt/seu/home-skel (see vm/Dockerfile) and copied in once. A volume cloned
# from a template already has it, and keeps everything it has.
set -eu

HOME_DIR=/home/seu
SKEL=/opt/seu/home-skel
MARKER="$HOME_DIR/.seu-home"

if [ ! -e "$MARKER" ]; then
  cp -a "$SKEL/." "$HOME_DIR/"
  touch "$MARKER"
  chown seu:seu "$MARKER"
fi

# Not recursive: the home is seu's, but ~/.local/share/docker is dockerd's.
chown seu:seu "$HOME_DIR"
