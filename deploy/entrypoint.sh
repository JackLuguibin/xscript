#!/bin/sh
# Container entrypoint: create the first admin on an empty /data, then run the CLI.
#
#   docker run … xscript-server            → serve (behind a proxy, all interfaces)
#   docker run … xscript-server backup     → any other xscript-server subcommand
set -eu

if [ "${1:-serve}" = "serve" ]; then
  shift || true
  if [ -n "${XSCRIPT_ADMIN_PASSWORD:-}" ]; then
    # Only acts on first start; afterwards the password lives in the database.
    xscript-server init --if-missing --username "${XSCRIPT_ADMIN_USER:-admin}"
  fi
  exec xscript-server serve --host 0.0.0.0 --port 8765 --behind-proxy \
    --forwarded-allow-ips "${XSCRIPT_FORWARDED_ALLOW_IPS:-*}" "$@"
fi
exec xscript-server "$@"
