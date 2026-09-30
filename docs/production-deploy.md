# Deploy Live Hub with Docker Compose

This deploys the `ggz24livehub` web UI, API/FFmpeg, worker, PostgreSQL, Redis, and Caddy on one Linux server. Caddy serves HTTPS. PostgreSQL, Redis, API, and web have no public host ports. The database, video library, and TLS certificates use persistent Docker volumes.

For the current Google Compute Engine VM and a step-by-step data migration, see [google-cloud-vm-deploy.md](google-cloud-vm-deploy.md).

## Before first start

1. Prepare a Linux server with Docker Engine and Docker Compose. Allow inbound TCP 80/443 and UDP 443; restrict SSH to your administrators. Size CPU, disk, and outbound traffic by testing your actual videos. One server is a single point of failure and does not guarantee ten simultaneous TikTok streams.
2. Register a domain and set its DNS A record to this server's public IPv4 address. Wait for DNS to resolve. No domain is required to build the images, but Caddy needs a real domain and reachable ports to obtain a public certificate.
3. Clone this repository. From its root, run `node scripts/setup-production-env.mjs` if Node is available, or copy `.env.production.example` to `.env.production` and fill every required value. The setup script preserves the local account encryption key when run on a machine that has `.env`; **keep that exact key when moving existing account data**. Never commit or share the filled file.
4. Set `DOMAIN` in `.env.production` to the hostname only, without `https://`. Change the login password before internet exposure if it has been shared. Keep `APP_USERNAME` unchanged when restoring accounts: it is the account owner identifier in the current database.
5. Run `node scripts/check-production-env.mjs` and `docker compose --env-file .env.production -f compose.production.yaml config --quiet`. If the host has only Docker, run `docker run --rm -v "$PWD:/work" -w /work node:22-alpine node scripts/check-production-env.mjs` instead of the first command. On Linux, set `chmod 600 .env.production`.

## Start and verify

```bash
docker compose --env-file .env.production -f compose.production.yaml up --build -d
docker compose --env-file .env.production -f compose.production.yaml ps
curl -I "https://YOUR_DOMAIN/live/login"
```

The one-shot `migrate` service applies the reviewed Prisma schema before the API starts. The API then ensures its live-account tables exist. A successful health check means containers and dependencies are up; it does not prove TikTok room creation, product add, or LIVE playback. Test those with an authorized account before enabling AUTO schedules.

## Backups and updates

Run `bash scripts/backup-production.sh` regularly. It saves a PostgreSQL dump, the media volume, and the environment secrets under `backups/`. The directory is private on the server but **not encrypted**; move it to encrypted off-server storage and test restoration. Retain the account encryption key or stored TikTok cookies cannot be decrypted. Check that enough free disk is available before backing up large videos. Avoid uploads or deletions while copying media for a consistent backup.

Before updating, check that no account is LIVE. Recreating the API container stops its FFmpeg processes. Make a backup, deploy the reviewed code, and run:

```bash
docker compose --env-file .env.production -f compose.production.yaml up --build -d
docker compose --env-file .env.production -f compose.production.yaml ps
```

Do not use `docker compose down -v`: it deletes the database, video, and certificate volumes. If restoring on a new server, copy `secrets.env` to `.env.production` first, start only PostgreSQL, restore `database.dump` into the empty database with `pg_restore`, and extract `media.tar` into the media volume using a one-off API image. Start the full stack only after the restore is complete. Do not restore over a running application or an existing populated database.

For an existing backup, the restore on a **new empty** deployment is:

```bash
cp /path/to/backup/secrets.env .env.production
chmod 600 .env.production
# Set DOMAIN to the server's real hostname and rotate a previously shared APP_PASSWORD.
docker run --rm -v "$PWD:/work" -w /work node:22-alpine node scripts/check-production-env.mjs
docker compose --env-file .env.production -f compose.production.yaml up -d postgres
cat /path/to/backup/database.dump | docker compose --env-file .env.production -f compose.production.yaml exec -T postgres pg_restore --exit-on-error --no-owner --no-acl -U livehub -d livehub
docker compose --env-file .env.production -f compose.production.yaml build api
cat /path/to/backup/media.tar | docker compose --env-file .env.production -f compose.production.yaml run --rm -T --no-deps --entrypoint sh api -c 'tar -C /app/media -xf -'
docker compose --env-file .env.production -f compose.production.yaml up --build -d
```

To move the data currently stored by the **local** `compose.yaml` stack, run `node scripts/export-local-data.mjs` on that machine while its containers are running. It writes a binary-safe database dump, media archive, prepared environment file, and checksums under `backups/`. Avoid uploads and deletes during the export. Transfer that directory securely to the new server, verify `sha256sum -c SHA256SUMS`, then use the restore commands above. Do not send `.env` or `.env.production` through GitHub.

## Current limits

The UI has one administrator login. API FFmpeg processes and the media volume live on one server, so adding API replicas with Compose would not distribute streams safely. AUTO room creation and product requests depend on TikTok endpoints and a configured signer; real account behavior must be verified. Uploads remain limited to 8 GiB per file and 40 GiB per owner. Set `MAX_CONCURRENT_LIVE` in `.env.production` only if an operational limit is needed; blank leaves the application count uncapped, while physical server limits still apply.
