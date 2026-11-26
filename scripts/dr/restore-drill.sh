#!/usr/bin/env bash
# Restore drill (P9-D): builds a source database (migrations + seed + scripts/dr/fixture.sql), takes a logical backup
# (pg_dump custom format), restores it into a fresh Postgres container, then checks the copy: migrations and drift,
# scripts/dr/verify.sql (stock, lots, serials, payment ledger, sequences, append-only triggers) and a row-by-row
# fingerprint diff against the source (scripts/dr/fingerprint.sql). Prints a timed report with the measured RTO and
# exits non-zero on any mismatch. Needs only bash and Docker: Postgres runs in two throwaway containers on their own
# network (no host ports), Node runs in the e2e runner image. Runbook: docs/runbooks/backup-and-restore.md.
#
# Usage, from the repo root or a worktree: bash scripts/dr/restore-drill.sh [--orders N] [--keep]
#   --orders N  orders in the drill dataset (default 400); the seed adds 500 products
#   --keep      leave the containers, network and dump in place for inspection (remove them with --cleanup)
#   --cleanup   only remove what an earlier --keep run left behind
set -euo pipefail

orders=400
keep=false
cleanup_only=false
while (($#)); do
  case "$1" in
    --orders) orders="${2:?--orders needs a number}"; shift 2 ;;
    --keep) keep=true; shift ;;
    --cleanup) cleanup_only=true; shift ;;
    *) echo "Unknown option '$1'. Usage: restore-drill.sh [--orders N] [--keep] [--cleanup]" >&2; exit 1 ;;
  esac
done
if ! [[ "$orders" =~ ^[0-9]+$ ]] || ((orders < 16)); then
  echo "--orders must be a number >= 16, got '$orders'" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"
export MSYS_NO_PATHCONV=1 # Git Bash would rewrite the container paths below into Windows paths

pg_image=postgres:16
network=emma-dr-net
source_container=emma-dr-source
target_container=emma-dr-target
source_db=emma_dr_source_test
target_db=emma_dr_restore_test
out=tmp/dr
dump="$out/drill.dump"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
report="$out/restore-drill-$stamp.txt"

remove_drill_resources() {
  docker rm -f "$source_container" "$target_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -f "$dump"
}
if $cleanup_only; then
  remove_drill_resources
  echo "Removed the drill containers, network and dump."
  exit 0
fi

on_exit() {
  local status=$?
  if $keep; then
    echo "Kept: containers $source_container, $target_container, network $network, $dump (remove: --cleanup)"
  else
    remove_drill_resources
  fi
  exit $status
}
trap on_exit EXIT

mkdir -p "$out"
: >"$report"
log() { echo "$*" | tee -a "$report"; }
now() { date +%s%N; }
declare -a step_names=() step_seconds=()
timed() {
  local name="$1" started
  shift
  started=$(now)
  "$@" || return
  step_names+=("$name")
  step_seconds+=("$(awk -v a="$started" -v b="$(now)" 'BEGIN { printf "%.1f", (b - a) / 1e9 }')")
}
seconds_of() {
  local i
  for i in "${!step_names[@]}"; do [[ "${step_names[$i]}" == "$1" ]] && echo "${step_seconds[$i]}"; done
}
psql_in() { # psql_in <container> <database> [psql args...]
  local container="$1" database="$2"
  shift 2
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U drill -d "$database" "$@"
}

start_postgres() {
  remove_drill_resources
  docker network create "$network" >/dev/null
  local container
  for container in "$source_container" "$target_container"; do
    # Trust auth inside a private network with no published port: the drill holds no secret.
    docker run -d --name "$container" --network "$network" -e POSTGRES_USER=drill -e POSTGRES_DB=postgres \
      -e POSTGRES_HOST_AUTH_METHOD=trust "$pg_image" >/dev/null
  done
  for container in "$source_container" "$target_container"; do
    # TCP only answers once the image's init has finished (its temporary server listens on the socket only).
    local tries=0
    until docker exec "$container" pg_isready -q -h 127.0.0.1 -U drill; do
      ((++tries < 120)) || { echo "$container did not start" >&2; return 1; }
      sleep 0.5
    done
  done
  psql_in "$source_container" postgres -c "CREATE DATABASE $source_db"
}

runner_image() {
  local image
  image="emma-e2e-runner:$(sha256sum package-lock.json | cut -c1-12)"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "Building $image (package-lock.json changed)" >&2
    tar -cf - package.json package-lock.json -C scripts/e2e Dockerfile | docker build -q -t "$image" - >/dev/null
  fi
  echo "$image"
}

# Runs a shell command in the runner image with the repository (no .env files) in /app and DATABASE_URL set.
in_runner() { # in_runner <database url> <command>
  tar -cf - --exclude=node_modules --exclude=.git --exclude=dist --exclude=tmp --exclude=logs --exclude=.claude \
    --exclude='.env*' --exclude=src/generated . |
    docker run -i --rm --network "$network" -e DATABASE_URL="$1" "$image" sh -c "tar -x -C /app && $2"
}

source_url="postgresql://drill@$source_container:5432/$source_db"
target_url="postgresql://drill@$target_container:5432/$target_db"

build_source() {
  in_runner "$source_url" 'npx prisma generate >/dev/null 2>&1 && npx prisma migrate deploy 2>&1 | tail -1 &&
    npx prisma db seed 2>&1 | grep -E "^Created|completed|rror" ' | sed 's/^/  /'
}
load_fixture() { psql_in "$source_container" "$source_db" -v orders="$orders" -f - <scripts/dr/fixture.sql >/dev/null; }

check_source() {
  if ! psql_in "$source_container" "$source_db" -f - <scripts/dr/verify.sql >"$out/verify-source.txt" 2>&1; then
    cat "$out/verify-source.txt" >&2
    echo "The SOURCE database fails verify.sql: the drill dataset is inconsistent, so the restore cannot be judged." >&2
    return 1
  fi
  psql_in "$source_container" "$source_db" -At -f - <scripts/dr/fingerprint.sql >"$out/fingerprint-source.txt"
}

backup() {
  docker exec "$source_container" pg_dump -U drill -d "$source_db" --format=custom --compress=6 --file=/tmp/drill.dump
  docker cp -q "$source_container:/tmp/drill.dump" "$dump"
}

restore() {
  docker cp -q "$dump" "$target_container:/tmp/drill.dump"
  psql_in "$target_container" postgres -c "CREATE DATABASE $target_db"
  docker exec "$target_container" pg_restore -U drill -d "$target_db" --no-owner --no-privileges --exit-on-error \
    --jobs=4 /tmp/drill.dump
}
analyze() { docker exec "$target_container" vacuumdb -q -U drill -d "$target_db" --analyze-only; }

migration_status=unknown
check_migrations() {
  local output
  output=$(in_runner "$target_url" 'npx prisma migrate status >/tmp/status.txt 2>&1;
    s=$?; tail -1 /tmp/status.txt; echo "migrate status exit $s";
    npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code >/dev/null 2>&1;
    echo "drift exit $?"') || true
  echo "$output" | sed 's/^/  /' | tee -a "$report"
  if grep -q '^migrate status exit 0$' <<<"$output" && grep -q '^drift exit 0$' <<<"$output"; then
    migration_status=ok
  else
    migration_status=FAIL
  fi
}

verify_status=unknown
check_integrity() {
  if psql_in "$target_container" "$target_db" -f - <scripts/dr/verify.sql >"$out/verify-target.txt" 2>&1; then
    verify_status=ok
  else
    verify_status=FAIL
  fi
}

fingerprint_status=unknown
compare_fingerprints() {
  psql_in "$target_container" "$target_db" -At -f - <scripts/dr/fingerprint.sql >"$out/fingerprint-target.txt"
  if diff "$out/fingerprint-source.txt" "$out/fingerprint-target.txt" >"$out/fingerprint-diff.txt"; then
    fingerprint_status=ok
  else
    fingerprint_status=FAIL
  fi
}

log "Restore drill $stamp: $orders orders, $pg_image, containers $source_container -> $target_container"
image=$(runner_image)
timed "source: start Postgres containers" start_postgres
log "Building the source database (migrations + seed):"
if ! timed "source: migrate + seed" build_source >"$out/source-build.txt" 2>&1; then
  cat "$out/source-build.txt" >&2
  exit 1
fi
tee -a "$report" <"$out/source-build.txt"
timed "source: drill dataset (fixture.sql)" load_fixture
timed "source: verify + fingerprint" check_source
timed "backup: pg_dump --format=custom" backup
timed "restore: pg_restore --jobs=4" restore
timed "restore: analyze" analyze
timed "check: migrations applied, no drift" check_migrations
timed "check: integrity (verify.sql)" check_integrity
timed "check: fingerprint diff" compare_fingerprints

dump_bytes=$(wc -c <"$dump" | tr -d ' ')
tables=$(grep -c '^table|' "$out/fingerprint-source.txt")
rows=$(grep '^table|' "$out/fingerprint-source.txt" | sed -E 's/.*\|rows=([0-9]+).*/\1/' | awk '{ s += $1 } END { print s }')
unpublished=$(grep 'outbox: unpublished events' "$out/verify-source.txt" | awk -F'|' '{ gsub(/ /, "", $2); print $2 }')
unprobed=$(grep 'triggers on empty tables' "$out/verify-target.txt" | awk -F'|' '{ gsub(/ /, "", $2); print $2 }')
rto=0
for step in "restore: pg_restore --jobs=4" "restore: analyze" "check: migrations applied, no drift" \
  "check: integrity (verify.sql)" "check: fingerprint diff"; do
  rto=$(awk -v a="$rto" -v b="$(seconds_of "$step")" 'BEGIN { printf "%.1f", a + b }')
done

log ""
log "Step                                        Seconds"
for i in "${!step_names[@]}"; do log "$(printf '%-44s %7s' "${step_names[$i]}" "${step_seconds[$i]}")"; done
log ""
log "Dataset: $tables tables, $rows rows; dump $dump_bytes bytes"
log "Measured RTO (restore + analyze + all checks): ${rto} s"
log ""
log "Restored database checks (verify.sql):"
sed 's/^/  /' "$out/verify-target.txt" | tee -a "$report"
log ""

failures=()
[[ "$migration_status" == ok ]] || failures+=("migrations: prisma migrate status or drift check failed")
[[ "$verify_status" == ok ]] || failures+=("integrity: verify.sql has FAIL rows")
if [[ "$fingerprint_status" == ok ]]; then
  log "Fingerprint (row counts + row checksums per table, triggers, constraints, indexes, functions, sequences, enums):"
  log "  identical: $(wc -l <"$out/fingerprint-source.txt" | tr -d ' ') lines"
else
  failures+=("fingerprint: the restored database differs from the source")
  log "Fingerprint differences (< source, > restored):"
  head -40 "$out/fingerprint-diff.txt" | sed 's/^/  /' | tee -a "$report"
fi
# The dataset is built to exercise these, so a gap here means the drill no longer covers them.
((unpublished > 0)) || failures+=("coverage: the source has no unpublished outbox events")
[[ "$unprobed" == 0 ]] || failures+=("coverage: $unprobed append-only triggers sit on tables the dataset leaves empty")

log ""
if ((${#failures[@]})); then
  for failure in "${failures[@]}"; do log "FAIL $failure"; done
  log "RESULT: FAIL (report: $report)"
  exit 1
fi
log "RESULT: PASS (report: $report)"
