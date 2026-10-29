#!/bin/sh
# Starts SearXNG for the `search` service (compose.yml; docs/SERVER.md §9). It sets a random
# secret at every start, and writes searxng.yml with the residential proxy's URL
# (SEARCH_PROXY_URL, from .env.search) over its placeholders. Without a URL it drops those
# lines, and the paid engines go direct. The copy with the URL lives only in /tmp, a tmpfs.
set -eu
umask 077
SEARXNG_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export SEARXNG_SECRET
if [ -n "${SEARCH_PROXY_URL:-}" ]; then
  url="$(printf '%s' "$SEARCH_PROXY_URL" | sed 's/[\\&|]/\\&/g')"
  sed "s|__SEARCH_PROXY_URL__|$url|" /etc/searxng/settings.yml > /tmp/settings.yml
else
  sed '/__SEARCH_PROXY_URL__/d' /etc/searxng/settings.yml > /tmp/settings.yml
fi
unset SEARCH_PROXY_URL url
export SEARXNG_SETTINGS_PATH=/tmp/settings.yml
exec /usr/local/searxng/entrypoint.sh
