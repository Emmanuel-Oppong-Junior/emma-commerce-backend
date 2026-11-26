#!/usr/bin/env bash
# The P9-L load test. Usage, from the repo root or a worktree:
#   bash ops/loadtest/run.sh [all|up|seed|smoke|load|stats|down]   (default: all = up + seed + load)
# up     builds the app image and starts the local stack (compose project emma-load: Postgres :5434, Redis :6381,
#        API :3100, metrics :9465) with generated secrets in tmp/loadtest/stack.env
# seed   writes the load-test data into the stack's database (idempotent)
# smoke  one pass of every scenario (checks the scripts and the stack in about a minute)
# load   the 3x-peak profile (SCALE=n multiplies it); summary in tmp/loadtest/<profile>-x<scale>-summary.json, exit code 99 when a threshold fails
# stats  pg_stat_statements top queries and the Paystack/Resend stub counters
# down   stops the stack and deletes its volumes
# Against another environment: BASE_URL=https://staging.example LOAD_USER_PASSWORD=... PAYSTACK_SECRET_KEY=<its test
# key> bash ops/loadtest/run.sh load (seed it first with DATABASE_URL=... bash ops/loadtest/run.sh seed).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
here=ops/loadtest
compose=(docker compose -f "$here/docker-compose.yml")
k6_image=grafana/k6:1.3.0
env_file=tmp/loadtest/stack.env
mkdir -p tmp/loadtest

stack_value() { sed -n "s/^$1=//p" "$env_file"; }

write_env() {
  [[ -f "$env_file" ]] && return
  hex() { node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"; }
  {
    echo "JWT_SECRET=$(hex)"
    echo "JWT_REFRESH_SECRET=$(hex)"
    echo "JWT_RESET_SECRET=$(hex)"
    echo "MFA_ENCRYPTION_KEY=$(hex)"
    echo "PAYMENT_CONFIG_ENCRYPTION_KEY=$(hex)"
    echo "JWT_TOKEN_AUDIENCE=emma-load"
    echo "JWT_TOKEN_ISSUER=emma-load"
    echo "GOOGLE_CLIENT_ID=load-google-client"
    echo "GOOGLE_CLIENT_SECRET=$(hex)"
    echo "FACEBOOK_APP_ID=load-facebook-app"
    echo "FACEBOOK_APP_SECRET=$(hex)"
    echo "CLOUDINARY_CLOUD_NAME=load-cloud"
    echo "CLOUDINARY_API_KEY=load-cloudinary-key"
    echo "CLOUDINARY_API_SECRET=$(hex)"
    echo "RESEND_API_KEY=load_$(hex)"
    echo "PAYSTACK_SECRET_KEY=stub_$(hex)"
    echo "LOAD_USER_PASSWORD=Load-$(hex | cut -c1-20)"
  } >"$env_file"
}

up() {
  write_env
  if [[ -z "${LOAD_SKIP_BUILD:-}" ]]; then
    echo "Building emma-commerce-load:dev from the Dockerfile"
    docker build -q -t emma-commerce-load:dev . >/dev/null
  fi
  "${compose[@]}" up -d --build --wait postgres redis stubs api worker
  echo "Stack up: API http://localhost:3100/graphql"
}

seed() {
  local url="${DATABASE_URL:-postgresql://load:load@localhost:5434/emma_load}"
  local password="${LOAD_USER_PASSWORD:-$(stack_value LOAD_USER_PASSWORD)}"
  DATABASE_URL="$url" LOAD_USER_PASSWORD="$password" npx ts-node --transpile-only "$here/seed.ts"
}

run_k6() {
  local profile=$1
  local summary="$profile-x${SCALE:-1}-summary.json"
  local args=(run --quiet -e "PROFILE=$profile" -e "SCALE=${SCALE:-1}" --summary-export "/results/$summary" scenarios/main.js)
  if [[ -n "${BASE_URL:-}" ]]; then
    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/$here:/loadtest:ro" -v "$PWD/tmp/loadtest:/results" -w /loadtest \
      -e BASE_URL -e LOAD_USER_PASSWORD -e PAYSTACK_SECRET_KEY "$k6_image" "${args[@]}"
  else
    MSYS_NO_PATHCONV=1 "${compose[@]}" --profile k6 run --rm -e BASE_URL=http://api:3000 \
      -e "LOAD_USER_PASSWORD=$(stack_value LOAD_USER_PASSWORD)" \
      -e "PAYSTACK_SECRET_KEY=$(stack_value PAYSTACK_SECRET_KEY)" k6 "${args[@]}"
  fi
}

stats() {
  "${compose[@]}" exec -T postgres psql -U load -d emma_load -c "
    SELECT calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 1) AS max_ms,
      round(total_exec_time::numeric) AS total_ms, rows, left(regexp_replace(query, '\s+', ' ', 'g'), 160) AS query
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'emma_load')
    ORDER BY total_exec_time DESC LIMIT 25"
  echo "Stub counters: $("${compose[@]}" exec -T stubs wget -qO- http://127.0.0.1:8080/stats)"
}

reset_stats() {
  "${compose[@]}" exec -T postgres psql -U load -d emma_load -qc \
    "CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT pg_stat_statements_reset()" >/dev/null
}

case "${1:-all}" in
  up) up ;;
  seed) seed ;;
  smoke) run_k6 smoke ;;
  load)
    [[ -z "${BASE_URL:-}" ]] && reset_stats
    run_k6 peak3x
    ;;
  stats) stats ;;
  down) "${compose[@]}" --profile k6 down -v ;;
  all)
    up
    seed
    reset_stats
    run_k6 peak3x
    ;;
  *)
    echo "Unknown command '$1' (all|up|seed|smoke|load|stats|down)" >&2
    exit 1
    ;;
esac
