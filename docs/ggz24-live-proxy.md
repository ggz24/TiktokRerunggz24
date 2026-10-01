# ggz24.com/live reverse proxy (live on 2026-10-01)

Traffic path: browser → Cloudflare (TLS for ggz24.com) → nginx on VM `instance-20260628-042413`
(project `superb-system-500717-n2`, aaPanel nginx at `/www/server/nginx`) → `http://34.21.142.197:8080`
(Caddy on VM `ggz24livehub`, serves only `/live` and `/live/*`) → Next.js web (`basePath=/live`).

## What was added on the front VM

One new file, nothing existing was edited:
`/www/server/panel/vhost/nginx/proxy/app2.rpaultra.com/livehub_live.conf`

`ggz24.com` is served by the server block in `app2.rpaultra.com.conf` (its `server_name` lists
`ggz24.com www.ggz24.com`). The file defines `location = /live` and `location ^~ /live/`, answers 404 for
any other Host, forwards the original Host, `X-Forwarded-Proto: https` and the real client IP
(`CF-Connecting-IP`), disables request buffering and allows 64 MB bodies (video chunks are 32 MB; Cloudflare
caps request bodies at 100 MB).

## Firewall

Project `livehub-510209` rule `ggz24livehub-live-proxy-8080` allows `tcp:8080` only from `34.21.250.108`
(the front VM's external IP). Both VMs are in different projects/VPCs, so the public IP is used.

## Undo

On the front VM:

```bash
sudo unlink /www/server/panel/vhost/nginx/proxy/app2.rpaultra.com/livehub_live.conf
sudo /www/server/nginx/sbin/nginx -t && sudo /www/server/nginx/sbin/nginx -s reload
```

Notes: aaPanel may regenerate vhost files when the site is edited in the panel; the include of
`proxy/app2.rpaultra.com/*.conf` is part of the panel template, so the file survives normal edits. If the panel
renames or deletes proxy rules, re-add the file. Reaching the front VM needs IAP:
`gcloud compute ssh instance-20260628-042413 --project=superb-system-500717-n2 --zone=asia-southeast1-c --tunnel-through-iap`.
