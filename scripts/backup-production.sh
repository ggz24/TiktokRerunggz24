#!/usr/bin/env bash
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
if [[ ! -f .env.production ]]; then
  echo 'Missing .env.production' >&2
  exit 1
fi

mkdir -p -m 700 backups
backup_dir="$(mktemp -d "backups/backup-$(date -u +%Y%m%dT%H%M%SZ)-XXXX")"
compose=(docker compose --env-file .env.production -f compose.production.yaml)
"${compose[@]}" exec -T postgres pg_dump -U livehub -d livehub -Fc > "$backup_dir/database.dump"
"${compose[@]}" exec -T api tar -C /app/media -cf - . > "$backup_dir/media.tar"
cp .env.production "$backup_dir/secrets.env"
(cd "$backup_dir" && sha256sum database.dump media.tar secrets.env > SHA256SUMS)
echo "Backup saved to $backup_dir"
echo 'Copy this directory to encrypted off-server storage; it contains account secrets and videos.'
