# Deploy ggz24livehub on the Google Cloud VM

This guide is for project `livehub-510209`, VM `ggz24livehub` in `asia-southeast1-c`, Debian 13, and the current external IP `34.21.142.197`. Run these steps yourself. The source belongs on GitHub; the database, video files, and secrets do **not**.

## 1. Check the VM and network

- Keep at least 100 GB of boot-disk space. The current local media backup is about 3.6 GB; Docker images, conversion working files, and future videos need more room.
- In the VM's Networking settings, allow HTTP and HTTPS traffic (TCP 80 and 443). Keep database, Redis, API, and Next.js ports closed to the internet. The production Compose file publishes only Caddy's web ports.
- Reserve the VM's current external IP as static before relying on the hostname. If the IP changes, the hostname below must change too.
- Temporary hostname: `ggz24livehub.34-21-142-197.sslip.io`. Set `DOMAIN` to the hostname **without** `https://`. Replace it with a domain you control later if preferred.
- Set a Google Cloud billing budget and alerts. An alert is not a hard spending cap. Live video outbound transfer and disk storage add to the VM cost.

## 2. Install Docker on Debian 13

In the Google Cloud VM list, click **SSH** next to `ggz24livehub`. Run:

```bash
sudo apt update
sudo apt install -y ca-certificates curl nano
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: trixie
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
```

All remaining VM Docker commands use `sudo`, so the `admin` user does not need membership in the root-equivalent Docker group. On a 4 GB RAM VM, if the image build runs out of memory, add swap before retrying; do not change the VM size until memory usage has been checked.

## 3. Fetch the current source

After the latest commit is visible on GitHub, run on the VM:

```bash
git clone https://github.com/notza0816581058/Tiktok-rerun.git ~/ggz24livehub
cd ~/ggz24livehub
git status --short --branch
```

Do not start the containers yet. The new database would be empty and the video library would be missing.

## 4. Copy the local data privately

On the Windows PC running the existing `live-hub` Docker stack, stop changing the library while making an export. From PowerShell in `C:\Users\Admin\Desktop\Tiktokrerun\live-hub`, run `node scripts/export-local-data.mjs`. This creates a new `backups\backup-local-...` directory containing `database.dump`, `media.tar`, `secrets.env`, and `SHA256SUMS`. Keep the exact `ACCOUNT_ENCRYPTION_KEY` and `APP_USERNAME` from this export: existing account records depend on them. The backup is unencrypted and contains private data.

Install Google Cloud CLI on Windows, sign in with `gcloud init`, and select project `livehub-510209`. In PowerShell, substitute the actual backup folder name:

```powershell
Set-Location 'C:\Users\Admin\Desktop\Tiktokrerun\live-hub'
gcloud compute scp --recurse '.\backups\backup-local-YYYYMMDDTHHMMSS-XXXXXX' 'ggz24livehub:~/' --zone=asia-southeast1-c --project=livehub-510209
```

The archive is several gigabytes, so this transfer can take a while. Never send `secrets.env`, `.env`, `.env.production`, `database.dump`, or `media.tar` to GitHub, chat, or a public file-sharing service.

## 5. Restore data, then start the site

Back in the VM SSH window, replace `BACKUP_FOLDER` below with the folder that was copied. The commands assume this is a **new, empty** production deployment:

```bash
cd ~/ggz24livehub
BACKUP_FOLDER=backup-local-YYYYMMDDTHHMMSS-XXXXXX
cd ~/$BACKUP_FOLDER
sha256sum -c SHA256SUMS
cd ~/ggz24livehub
cp ~/$BACKUP_FOLDER/secrets.env .env.production
chmod 600 .env.production
nano .env.production
```

In the editor, set `DOMAIN=ggz24livehub.34-21-142-197.sslip.io`. Change `APP_PASSWORD` to a new long private password if the old one was ever shared, and initially set `MAX_CONCURRENT_LIVE=1` while checking actual VM and outbound-transfer costs. Preserve `APP_USERNAME` and `ACCOUNT_ENCRYPTION_KEY`. Save with Ctrl+O, Enter, Ctrl+X. Do not paste the file contents into chat.

```bash
sudo docker run --rm -v "$PWD:/work" -w /work node:22-alpine node scripts/check-production-env.mjs
sudo docker compose --env-file .env.production -f compose.production.yaml config --quiet
sudo docker compose --env-file .env.production -f compose.production.yaml up -d postgres
cat ~/$BACKUP_FOLDER/database.dump | sudo docker compose --env-file .env.production -f compose.production.yaml exec -T postgres pg_restore --exit-on-error --no-owner --no-acl -U livehub -d livehub
sudo docker compose --env-file .env.production -f compose.production.yaml build api
cat ~/$BACKUP_FOLDER/media.tar | sudo docker compose --env-file .env.production -f compose.production.yaml run --rm -T --no-deps --entrypoint sh api -c 'tar -C /app/media -xf -'
sudo docker compose --env-file .env.production -f compose.production.yaml up --build -d
sudo docker compose --env-file .env.production -f compose.production.yaml ps
curl -I https://ggz24livehub.34-21-142-197.sslip.io/login
```

If a restore command fails, stop there and inspect the error; do not repeat `pg_restore` into a partly restored database. Do not use `docker compose down -v`, which removes the database and media volumes.

## 6. Verify before scheduling LIVE

Visit `https://ggz24livehub.34-21-142-197.sslip.io/login`, sign in, verify the existing account and video library, and test one authorized LIVE manually. A healthy container or successful login does not establish that TikTok room creation, basket additions, or automatic recovery work for the account. Keep AUTO schedules off until that test is complete. See [production-deploy.md](production-deploy.md) for backup and update procedures.

References: [Docker installation for Debian 13](https://docs.docker.com/engine/install/debian/), [Google Cloud CLI installer](https://docs.cloud.google.com/sdk/docs/install-sdk), [Google Cloud CLI file transfer](https://docs.cloud.google.com/sdk/gcloud/reference/compute/scp), [Google Cloud disk resizing](https://docs.cloud.google.com/compute/docs/disks/resize-persistent-disk).
