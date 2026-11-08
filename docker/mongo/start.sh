#!/bin/sh
# Starts the stack's MongoDB (compose.yml `mongo`): a single-member replica set with auth.
#
# A replica set with auth needs a keyFile, which its members use to trust each other. With one
# member nothing else ever reads it, so a fresh random one is written to tmpfs at every start
# (/run/mongo, owned by mongodb) instead of keeping a secret on disk. Then the image's own entrypoint
# runs mongod with compose's arguments.
set -eu
umask 077
head -c 756 /dev/urandom | base64 | tr -d '\n' > /run/mongo/keyfile
chmod 400 /run/mongo/keyfile
exec docker-entrypoint.sh "$@"
