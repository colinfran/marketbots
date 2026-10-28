#!/bin/sh
# The history service's first start (the postgres image runs /docker-entrypoint-initdb.d/* once,
# on an empty data volume): one role and one database of the same name per bot, each with
# TimescaleDB and pgvector. The role owns its database and nothing else, so each engine, holding
# only its own password, can reach only its own data. The tables come from the engines' migrations
# (@mb/history).
#
#   HISTORY_DATABASES    names, space-separated (compose.yml: "crypto_history stock_history")
#   <NAME>_PASSWORD      each one's password, e.g. CRYPTO_HISTORY_PASSWORD
set -e

for db in ${HISTORY_DATABASES:?HISTORY_DATABASES is not set}; do
  var="$(echo "$db" | tr '[:lower:]' '[:upper:]')_PASSWORD"
  pw="$(printenv "$var" || true)"
  if [ -z "$pw" ]; then
    echo "initdb: $var is not set" >&2
    exit 1
  fi
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v db="$db" -v pw="$pw" <<'SQL'
create role :"db" login password :'pw';
create database :"db" owner :"db";
revoke all on database :"db" from public;
SQL
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'SQL'
create extension if not exists timescaledb;
create extension if not exists vector;
SQL
  echo "initdb: created $db"
done
