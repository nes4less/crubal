#!/bin/sh
# Smoke (docs/design/completion.md O): bring the container up, migrate, make an owner, and run the host
# suite against the same database. Usage: ./smoke.sh   (from packages/crubal-host, Docker running)
set -eu
cd "$(dirname "$0")"
docker compose -f compose.yml up -d --build
trap 'docker compose -f compose.yml down' EXIT
for i in $(seq 1 30); do
  if curl -fsS http://localhost:8787/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://localhost:8787/health
echo
docker compose -f compose.yml exec -T host node bin/crubal-host.ts owner create smoke.example
CRUBAL_PG_URL=postgres://crubal:crubal@localhost:5432/crubal node --test test/*.test.ts
