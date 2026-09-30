# Flow: อัพ Tiktokrerun (live-hub) ขึ้น GitHub แล้ว deploy เป็น ggz24.com/live

วันที่ตรวจสอบ: 2026-09-30 สถานะและขั้นตอนด้านล่างอ้างอิงจากการตรวจ repo จริงในเครื่องนี้ ไม่ใช่การเดา

## 1. สถานะปัจจุบัน (ตรวจแล้ว)

- **GitHub**: repo มีอยู่แล้วที่ `https://github.com/notza0816581058/Tiktok-rerun`, branch `main` ตรงกับ `origin/main` (ไม่ ahead/behind) โค้ด baseline ขึ้น GitHub แล้ว
- **งานที่ยังไม่ push**: มีไฟล์แก้ไข/ใหม่ในเครื่องที่ยังไม่ commit — คือชุดงาน "production deploy" ทั้งหมด:
  - แก้ไข: `.dockerignore`, `.env.example`, `.gitignore`, `README.md`, `compose.yaml`, ไฟล์ `apps/api/*` (auto-live), ไฟล์ `apps/web/*` (login route, video route, LiveSessionPanel, VideoLibraryPanel, video-upload)
  - ไฟล์ใหม่: `Caddyfile`, `compose.production.yaml`, `.env.production.example`, `docs/production-deploy.md`, `docs/google-cloud-vm-deploy.md`, `scripts/backup-production.sh`, `scripts/check-production-env.mjs`, `scripts/export-local-data.mjs`, `scripts/setup-production-env.mjs`
  - เพิ่มในรอบนี้: `apps/web/next.config.ts` (เพิ่ม `basePath` แบบมีเงื่อนไข), `apps/web/lib/base-path.ts` (helper ใหม่ ยังไม่ถูกเรียกใช้จริง)
- **ความลับ**: `.env`, `.env.production`, `backups/`, `transfer/*.key|.tar|.dump` อยู่ใน `.gitignore` ครบแล้ว ตรวจ `git status` ไม่พบไฟล์เหล่านี้ค้างอยู่ — ปลอดภัยที่จะ commit ชุดงานปัจจุบัน
- **VM ปลายทาง**: `ggz24livehub` ใน project `livehub-510209`, zone `asia-southeast1-c`, IP ปัจจุบัน `34.21.142.197`, มีคู่มือ deploy ละเอียดอยู่แล้วที่ [production-deploy.md](production-deploy.md) และ [google-cloud-vm-deploy.md](google-cloud-vm-deploy.md)
- **โดเมนที่ตัดสินใจแล้ว**: `ggz24.com` มีเว็บไซต์หลักรันอยู่แล้วบน **VM คนละเครื่อง** ชื่อ `instance-20260628-042413` ต้องการให้ `live-hub` ไปโผล่ที่ path `/live` (`ggz24.com/live`) โดยไม่กระทบเว็บหลักที่ root

สรุป: นี่ไม่ใช่ deploy โดเมนเดียวแบบในคู่มือเดิม (ซึ่งสมมติว่า VM `ggz24livehub` เป็นเจ้าของทั้งโดเมน) แต่เป็น **reverse proxy ข้าม VM สองเครื่อง** โดย `instance-20260628-042413` เป็นด่านหน้ารับ TLS ของ `ggz24.com` แล้วส่งต่อเฉพาะ path `/live/*` มาที่ `ggz24livehub`

## 2. งานที่ต้องทำต่อ เรียงตามลำดับ

### 2.1 ทำให้แอปรองรับการรันใต้ path `/live` (โค้ด — ยังไม่เสร็จ)

`next.config.ts` เพิ่ม `basePath` จาก env `NEXT_PUBLIC_BASE_PATH` แล้ว และมี `apps/web/lib/base-path.ts` เตรียม helper `apiPath()` ไว้ แต่ **ยังไม่ได้เอาไปใช้** เพราะ `fetch()` ฝั่ง client ไม่ได้เติม `basePath` ให้อัตโนมัติ (ต่างจาก `<Link>`, `router.push()`, `redirect()` ที่ Next.js เติมให้เองแล้ว — ตรวจแล้วว่าจุดเหล่านั้นปลอดภัย)

ต้องแก้ `fetch('/api/...')` ที่ hardcode เป็น absolute path ให้เรียกผ่าน `apiPath('/api/...')` ใน 6 ไฟล์ (28 จุด):

| ไฟล์ | จำนวนจุด |
| --- | --- |
| `apps/web/components/CyberShell.tsx` | 11 |
| `apps/web/components/ProductCurlPanel.tsx` | 7 |
| `apps/web/components/LiveSessionPanel.tsx` | 5 |
| `apps/web/components/VideoLibraryPanel.tsx` | 2 |
| `apps/web/components/QuickProductSetPanel.tsx` | 2 |
| `apps/web/components/LoginForm.tsx` | 1 |

หลังแก้ ต้องรัน `npm run build` ด้วย `NEXT_PUBLIC_BASE_PATH=/live` เพื่อยืนยันว่าไม่มี route ไหนหลุด แล้วรันแบบไม่ตั้งค่า (ค่าว่าง) เพื่อยืนยันว่า dev/local ที่ `localhost:3100` ยังทำงานปกติเหมือนเดิม

### 2.2 ตั้งค่า reverse proxy ที่ VM หน้าด่าน (`instance-20260628-042413`) — ต้องเช็คก่อนเขียนสคริปต์จริง

ยังไม่ทราบว่า VM นี้รันเว็บเซิร์ฟเวอร์อะไร (Nginx, Apache, Caddy, หรืออื่น) ต้อง SSH เข้าไปดูก่อนว่า:

1. process ที่ bind port 80/443 คืออะไร (`sudo ss -tlnp | grep -E ':80|:443'`)
2. ไฟล์ config ของเว็บหลักอยู่ที่ไหน (เช่น `/etc/nginx/sites-enabled/*`, `/etc/caddy/Caddyfile`)

จากนั้นเพิ่ม location/route สำหรับ `ggz24.com` เท่านั้นที่ path `/live` (และ `/live/*`) ให้ proxy ไปที่ `ggz24livehub` **โดยคง path `/live` ไว้ในคำขอที่ส่งต่อ ห้าม strip prefix** เพราะฝั่ง `live-hub` ใช้ Next.js `basePath=/live` รอรับ path นี้อยู่แล้ว

ตัวอย่างถ้าเป็น Nginx (ปรับตาม config จริงที่เจอ):

```nginx
location /live/ {
    proxy_pass http://34.21.142.197:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

พอร์ต `8080` เป็นพอร์ตภายในที่ `ggz24livehub` เปิดรอเฉพาะงานนี้ (ดูข้อ 2.3) ควรจำกัด firewall ของ `ggz24livehub` ให้พอร์ตนี้รับได้เฉพาะ IP ของ `instance-20260628-042413` เท่านั้น ไม่เปิดสู่อินเทอร์เน็ตทั่วไป

### 2.3 เพิ่ม site block ภายในใน Caddy ของ `ggz24livehub`

`Caddyfile` ปัจจุบันมี block เดียวคือ `{$DOMAIN}` ซึ่งให้ Caddy ขอใบรับรอง TLS อัตโนมัติเอง — ใช้ได้กับ `ggz24livehub.34-21-142-197.sslip.io` เพราะ DNS ชี้มาที่เครื่องนี้จริง แต่ `ggz24.com` DNS ชี้ไปที่ `instance-20260628-042413` ไม่ใช่เครื่องนี้ ดังนั้น Caddy บน `ggz24livehub` **ขอใบรับรองของ `ggz24.com` เองไม่ได้** (ACME challenge จะ fail)

ทางแก้คือเพิ่ม site block ที่สองซึ่งฟังพอร์ตภายใน (plain HTTP ไม่ทำ auto-TLS) รับ traffic ที่ VM หน้าด่านส่งต่อมา:

```caddyfile
{$DOMAIN} {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
  }
  reverse_proxy web:3100 {
    header_up X-Real-IP {remote_host}
  }
}

:8080 {
  encode zstd gzip
  reverse_proxy web:3100 {
    header_up X-Real-IP {remote_host}
  }
}
```

ต้อง publish port `8080` เพิ่มใน `compose.production.yaml` service `caddy` (`ports: ['80:80', '443:443', '443:443/udp', '8080:8080']`) และเปิดเฉพาะ VPC/firewall rule ที่อนุญาตต้นทางจาก `instance-20260628-042413` เท่านั้น (ใช้ IP ภายใน ไม่ใช่ IP สาธารณะ ถ้าทั้งสอง VM อยู่ VPC เดียวกัน) — ตรงนี้ต้องดู network setup จริงของทั้งสอง VM ก่อนล็อก firewall

`DOMAIN` ใน `.env.production` ยังคงตั้งเป็น hostname ทดสอบ (`ggz24livehub.34-21-142-197.sslip.io`) ไว้แบบเดิมสำหรับตรวจสุขภาพเครื่องนี้ตรง ๆ ได้เสมอ ไม่ต้องเปลี่ยนเป็น `ggz24.com`

### 2.4 Commit และ push ขึ้น GitHub

ยังไม่ได้ commit/push ชุดงานใน [ข้อ 1](#1-สถานะปัจจุบัน-ตรวจแล้ว) — เมื่อพร้อม (และตรวจว่า diff ไม่มีความลับหลุดอีกครั้งด้วย `git status`/`git diff`) ให้:

```powershell
git add -A
git commit -m "Add production deploy stack and /live basePath support"
git push origin main
```

### 2.5 Deploy ที่ VM `ggz24livehub`

ทำตาม [google-cloud-vm-deploy.md](google-cloud-vm-deploy.md) ข้อ 3–6 ทุกขั้นตอน (clone, ย้ายข้อมูล local ด้วย `export-local-data.mjs`, restore, start) เพิ่มเติมจากคู่มือเดิม:

- build image ด้วย `NEXT_PUBLIC_BASE_PATH=/live` (ต้องส่งเป็น build arg ให้ `Dockerfile` — ตรวจ `Dockerfile` ว่ารับ env นี้ตอน `next build` หรือยัง ถ้ายังไม่รับต้องเพิ่ม `ARG`/`ENV` ใน `Dockerfile` เป้าหมาย `web`)
- หลังคอนเทนเนอร์รันแล้ว ทดสอบตรงที่เครื่องนี้ก่อนผ่าน `https://ggz24livehub.34-21-142-197.sslip.io/live/login` (ไม่ใช่ `/login` เฉย ๆ อีกต่อไป)

### 2.6 ตั้งค่าที่ VM หน้าด่านแล้วตรวจปลายทางจริง

ทำข้อ 2.2 ให้เสร็จ แล้วตรวจ `https://ggz24.com/live/login` จากเบราว์เซอร์จริง ตรวจว่า asset (JS/CSS), การ login, และ redirect ไป `/live/dashboard` ทำงานถูกต้องทั้งหมด — ปัญหาที่พบบ่อยกับ basePath คือ asset 404 (ลืมจุดใดจุดหนึ่งในข้อ 2.1) และ cookie/session ใช้ path `/` เป็นค่า default อยู่แล้วจึงไม่ต้องแก้

## 3. สิ่งที่ยังไม่รู้ / ต้องเช็คก่อนลงมือจริง

1. เว็บเซิร์ฟเวอร์ที่รันอยู่บน `instance-20260628-042413` คืออะไร (Nginx/Apache/Caddy/อื่น) — ต้อง SSH เข้าไปดูก่อนเขียน config จริงตามข้อ 2.2
2. VM สองเครื่องอยู่ VPC/project เดียวกันหรือคนละ project ของ Google Cloud — มีผลต่อว่าจะเปิด firewall แบบ internal IP ได้เลยหรือต้องผ่าน public IP
3. `Dockerfile` เป้าหมาย `web` รับ build arg `NEXT_PUBLIC_BASE_PATH` แล้วหรือยัง (ยังไม่ได้ตรวจ)

## 4. ลำดับสั้น ๆ สำหรับรอบถัดไป

1. แก้ 28 จุด `fetch('/api/...')` → `apiPath('/api/...')` ใน 6 ไฟล์ (ข้อ 2.1) แล้ว `npm run build` ทั้งสองโหมด
2. SSH เข้า `instance-20260628-042413` สำรวจเว็บเซิร์ฟเวอร์ที่รันอยู่ (ข้อ 3.1)
3. ตรวจ/แก้ `Dockerfile` ให้รับ `NEXT_PUBLIC_BASE_PATH` เป็น build arg
4. แก้ `compose.production.yaml` เพิ่มพอร์ต `8080` และ `Caddyfile` เพิ่ม site block ภายใน (ข้อ 2.3)
5. Commit + push (ข้อ 2.4) — ขอ confirm ก่อน push จริงทุกครั้ง
6. Deploy ที่ `ggz24livehub` ตามคู่มือเดิม + ทดสอบ `/live/login` ตรง ๆ ที่เครื่องนี้ก่อน
7. ตั้ง proxy ที่ VM หน้าด่านแล้วตรวจ `ggz24.com/live` จากภายนอก
8. เปิด AUTO schedule เฉพาะหลังทดสอบ LIVE จริงสำเร็จ ตามคำเตือนเดิมใน [production-deploy.md](production-deploy.md)
