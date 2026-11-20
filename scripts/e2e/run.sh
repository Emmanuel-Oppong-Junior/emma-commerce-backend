#!/usr/bin/env bash
# Runs the e2e suite in Linux (node:24) against the local emma-e2e-pg (5433) and emma-e2e-redis (6380) containers.
# Usage, from the repo root or a worktree: bash scripts/e2e/run.sh <database ending in _test> <redis db 0-15> [jest filters...]
# The database is recreated and the Redis DB flushed first. node_modules comes from a runner image built once per
# package-lock.json, so a run skips `npm ci`. Full output goes to tmp/e2e-<database>.txt.
set -euo pipefail

db="${1:?database name ending in _test}"
redis_db="${2:?Redis DB index 0-15}"
shift 2
[[ "$db" =~ ^[a-z0-9_]+_test$ ]] || { echo "Database name must match [a-z0-9_]+_test, got '$db'" >&2; exit 1; }
[[ "$redis_db" =~ ^([0-9]|1[0-5])$ ]] || { echo "Redis DB must be 0-15, got '$redis_db'" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"
image="emma-e2e-runner:$(sha256sum package-lock.json | cut -c1-12)"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "Building $image (package-lock.json changed)"
  tar -cf - package.json package-lock.json -C scripts/e2e Dockerfile | docker build -q -t "$image" - >/dev/null
fi

docker exec emma-e2e-pg psql -U e2e -d postgres -qc "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db" 2>&1 | grep -v NOTICE || true
docker exec emma-e2e-redis redis-cli -n "$redis_db" FLUSHDB >/dev/null

mkdir -p tmp
out="tmp/e2e-$db.txt"
url="postgresql://e2e:e2e@host.docker.internal:5433/$db"
set +e
tar -cf - --exclude=node_modules --exclude=.git --exclude=dist --exclude=tmp --exclude=logs --exclude=.claude \
  --exclude='.env*' --exclude=src/generated . |
  MSYS_NO_PATHCONV=1 docker run -i --rm --add-host=host.docker.internal:host-gateway \
    -e U="$url" -e R="redis://host.docker.internal:6380/$redis_db" "$image" sh -c '
      tar -x -C /app && npx prisma generate >/dev/null &&
      node scripts/write-test-env.js "$U" "$R" >/dev/null &&
      DATABASE_URL="$U" npx prisma migrate deploy 2>&1 | tail -1 | sed "s/^/migrate: /" &&
      (DATABASE_URL="$U" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code >/dev/null 2>&1; echo "drift exit $?") &&
      npm run test:e2e -- "$@" 2>&1' sh "$@" >"$out" 2>&1
status=$?
set -e
grep -E '^migrate: |drift exit|^Tests:' "$out" || tail -20 "$out"
grep -E '^FAIL|● ' "$out" | head -20 || true
exit $status
