#!/bin/sh
# Match the linuxserver.io *arr containers: run as PUID:PGID, own /config,
# honour UMASK_SET, then drop privileges. Files this container writes come
# out owned the same way Radarr's and Sonarr's do.
set -e

umask "${UMASK_SET:-022}"

if [ "$(id -u)" = "0" ]; then
  groupmod -o -g "${PGID:-1000}" node 2>/dev/null || true
  usermod -o -u "${PUID:-1000}" -g "${PGID:-1000}" node 2>/dev/null || true

  mkdir -p /config
  # Only fix ownership when it is actually wrong: chown -R on a large
  # bind mount at every boot is slow for no reason.
  if [ "$(stat -c %u /config)" != "${PUID:-1000}" ] || [ "$(stat -c %g /config)" != "${PGID:-1000}" ]; then
    chown -R "${PUID:-1000}:${PGID:-1000}" /config
  fi

  echo "suggestarr: starting as ${PUID:-1000}:${PGID:-1000} (TZ=${TZ:-UTC})"
  exec su-exec "${PUID:-1000}:${PGID:-1000}" "$@"
fi

# Already unprivileged (e.g. `user:` set in compose): just run.
exec "$@"
