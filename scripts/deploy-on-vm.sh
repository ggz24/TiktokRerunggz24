#!/usr/bin/env bash
# Update the production VM to the latest GitHub commit without touching account data.
# Run from the repo on the VM:  git pull --ff-only && sudo bash scripts/deploy-on-vm.sh
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
[[ -f .env.production ]] || { echo 'Missing .env.production' >&2; exit 1; }
compose=(docker compose --env-file .env.production -f compose.production.yaml)

fingerprint() {
  "${compose[@]}" exec -T postgres psql -U livehub -d livehub -At -c \
    "SELECT count(*) || ' ' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM livehub_account_imports t"
}

mkdir -p -m 700 "$HOME/backups"
backup="$HOME/backups/predeploy-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$backup"
"${compose[@]}" exec -T postgres pg_dump -U livehub -d livehub -Fc > "$backup/database.dump"
cp .env.production "$backup/secrets.env"
(cd "$backup" && sha256sum database.dump secrets.env > SHA256SUMS)
before="$(fingerprint)"
echo "Backup: $backup"
echo "Accounts before: $before"

"${compose[@]}" up -d --build

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null http://localhost:8080/live/login; then break; fi
  sleep 5
done
after="$(fingerprint)"
echo "Accounts after:  $after"
if [[ "$before" != "$after" ]]; then
  echo "WARNING: account data changed! Restore from $backup/database.dump" >&2
  exit 1
fi
curl -fsS -o /dev/null -w 'GET /live/login -> %{http_code}\n' http://localhost:8080/live/login
"${compose[@]}" ps --format '{{.Name}} {{.Status}}'
echo 'Deploy OK; account data identical.'
