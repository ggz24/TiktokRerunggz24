# Live Hub

เว็บไซต์กลางต้นแบบสำหรับงานไลฟ์ของทีม แยกจากเว็บอ้างอิง และไม่คัดลอกโค้ดหรือข้อมูลของระบบต้นทาง UI ตัวอย่างใช้ข้อมูลที่แต่งขึ้นใหม่ทั้งหมด ส่วนฟีเจอร์นำเข้าบัญชีรับ cURL ที่เจ้าของบัญชีวางเอง และเก็บเฉพาะคุกกี้แบบเข้ารหัสใน PostgreSQL ภายในเครื่อง

## ส่วนที่เพิ่มจากงานของน็อต (Day 03)

| งาน | สิ่งที่มีในโปรเจกต์ | สถานะ |
| --- | --- | --- |
| P0-2 Monorepo + Dev Environment | `apps/web`, `apps/api`, `apps/worker`, `packages/shared`, Docker Compose สำหรับ PostgreSQL/Redis/API/worker/web และ healthcheck | รันได้ใน Dev/Test |
| P0-4 Shared Package / Event Contracts | event envelope และ validator สำหรับ `live.*`, stats, comment, chat, product และ event เสริม; mock events และ tests | Proposed v1; รอทีม review |
| P0-6 TikTok Client Skeleton | typed transport, fixtures/tests, sanitized cURL template, proxy config, retry planner และ log redaction | Mock เท่านั้น; Pending verification |

งานของน็อตเกี่ยวกับเว็บนี้โดยตรง: เว็บอ่านสถานะ API/DB/Redis/worker ผ่าน `/api/system/health`; API ใช้ client mock สร้าง Live Stats แล้วแปลงเป็น shared event ที่ตรวจสอบได้; worker รับ event envelope บน Redis และส่ง heartbeat ให้เว็บตรวจสถานะ งานเหล่านี้เป็นฐานให้หน้าบัญชี ไลฟ์ สถิติ สินค้า และคอมเมนต์ต่อข้อมูลจริงภายหลัง

## เริ่มใช้งานด้วย Docker

ต้องมี Docker Desktop ที่เปิดใช้งานอยู่

เปิดเทอร์มินัลที่โฟลเดอร์รากของโปรเจกต์ แล้วรัน:

```powershell
npm run setup:local
docker compose up --build -d
docker compose ps
```

เปิด [http://localhost:3100/dashboard](http://localhost:3100/dashboard) เข้าสู่ระบบด้วย `APP_USERNAME` และ `APP_PASSWORD` ในไฟล์ `.env` ซึ่งคำสั่ง setup สร้างไว้เฉพาะเครื่องและ Git ไม่ติดตามไฟล์นี้ เก็บ `.env` เป็นความลับ ห้ามส่งให้ทีม ห้ามใส่ใน issue หรือ commit

ไฟล์ที่แชร์ใน repo คือ [`.env.example`](.env.example) เท่านั้น `npm run setup:local` จะเติมค่าที่ขาดโดยไม่เปลี่ยนค่าลับเดิม โดยเฉพาะ `ACCOUNT_ENCRYPTION_KEY` ซึ่งต้องใช้ค่าเดิมเพื่ออ่านคุกกี้บัญชีที่เข้ารหัสไว้

### นำเข้าบัญชีด้วย sessionid หรือ cURL

1. ลงชื่อเข้าใช้เว็บไซต์นี้ แล้วเปิดหน้า **Accounts → เพิ่มบัญชี**
2. วางค่า `sessionid` ของบัญชีที่คุณมีสิทธิ์ใช้งาน หรือเลือกโหมด cURL แล้ววางคำสั่ง **Copy as cURL (bash)** ต้นฉบับจาก DevTools พร้อมชื่อเรียกและชื่อไลฟ์
3. โหมด cURL รับเฉพาะ `HEAD https://www.tiktok.com/api/update/profile/` เพื่ออ่าน session cookie จากคำสั่ง ทั้งสองโหมดเรียก `GET https://www.tiktok.com/passport/web/account/info/` แบบอ่านอย่างเดียวด้วย session นั้น
4. เมื่อ TikTok ส่งรหัสผู้ใช้และชื่อบัญชีของผู้ที่เข้าสู่ระบบกลับมา จึงบันทึกคุกกี้แบบ AES-256-GCM ใน PostgreSQL และแสดง **เชื่อมต่อแล้ว** หาก session ใช้ไม่ได้ ระบบจะไม่เพิ่มบัญชี

บัญชีที่เคยเพิ่มก่อนมีขั้นตอนตรวจตัวตนสามารถกด **ตรวจการเชื่อมต่อ** เพื่ออัปเดตสถานะได้ คำขออ่านข้อมูลบัญชีนี้เป็น endpoint ภายในของเว็บ TikTok ซึ่งอาจเปลี่ยนภายหลัง ควรตรวจซ้ำเมื่อจะใช้งานจริง และงาน Live/Product ยังต้องมี integration ของทีมแยกต่างหาก

วาง cURL ต้นฉบับจาก DevTools ลงในแบบฟอร์มโดยตรง อย่าคัดลอกจากแชทที่อาจเติม `\` ลงในค่าคุกกี้ ตัดทอนข้อมูล หรือแทนค่าด้วย `***` ตัวอ่านคำสั่งรองรับลิงก์ Markdown ที่ URL ตรงกัน แต่ไม่แก้ไขค่าคุกกี้ที่เปลี่ยนไป ระบบจะไม่ใช้ cURL เพื่อสั่งแก้โปรไฟล์ เพิ่มสินค้า หรือเริ่มไลฟ์

### ตั้งค่าบัญชีและส่งวิดีโอไปยัง RTMP

หน้า **Accounts** แก้ชื่อเรียก ชื่อไลฟ์ที่แสดงในเว็บ และค่าการส่งสัญญาณของบัญชีได้ รวมทั้งลบบัญชีพร้อม session ที่เก็บไว้ในระบบ ระบบจะไม่ลบบัญชี TikTok บนแพลตฟอร์ม หากกำลังส่งสตรีมอยู่ ให้หยุดสตรีมก่อนลบบัญชี

การส่งสัญญาณจริงต้องมีสิทธิ์ LIVE, ห้อง LIVE และ RTMP server URL/stream key เลือกตั้งค่าด้วยตนเองหรือทดลองสร้างห้องอัตโนมัติได้:

1. เปิด **Live Session** เพื่ออัปโหลด MP4 ที่มีภาพและเสียง (สูงสุด 512 MiB ต่อไฟล์, 20 ไฟล์และ 2 GiB ต่อผู้ใช้) แล้วเลือกบัญชี วิดีโอ และชื่อห้อง
2. หากตั้งค่า RapidAPI signer แล้ว กด **สร้างห้องและดึงคีย์อัตโนมัติ** ระบบจะขอสร้างห้อง LIVE จริงและเก็บปลายทางเข้ารหัส โดยยังไม่เริ่มส่งคลิป หากยังใช้ไม่ได้ ให้เปิดห้องและรับ RTMP URL/key จาก TikTok แล้วกรอกที่ **Accounts → ตั้งค่า**
3. กด **เริ่มส่งสัญญาณจริง** แล้วดูสถานะจากหน้าต่าง Live; กด **หยุดสตรีม** เมื่อเสร็จ การเปลี่ยน MP4 หลังตั้งค่าครั้งแรกไม่ต้องกรอก key ซ้ำหากห้องเดิมยังใช้งานได้

RTMP URL/key เก็บแบบเข้ารหัสใน PostgreSQL และไม่แสดงกลับในหน้าเว็บ ขณะสตรีม FFmpeg ใช้ key ในคำสั่งของโปรเซส จึงควรจำกัดสิทธิ์เข้าถึง Docker/เครื่องที่รัน วิดีโอเก็บใน Docker volume `media_data` และรวมอยู่ในชุดสำรองเข้ารหัสวันที่ 28 กันยายนสำหรับย้ายเครื่อง คำว่า “กำลังส่งสัญญาณ” หมายถึง FFmpeg ส่งข้อมูลออก ไม่ใช่การยืนยันว่าห้อง TikTok เปิดให้ผู้ชมแล้ว การรีสตาร์ต API/container จะหยุดสตรีม ต้องตรวจสถานะและเริ่มใหม่เอง อย่านำ stream key ไปวางในแชทหรือ commit

### โครงสร้างทดลองสำหรับสร้างห้อง LIVE

`packages/tiktok-client/src/live-room.ts` เตรียมคำขอสร้างห้องและแยก RTMP URL/key; `rapidapi-signer.ts` ส่งข้อมูลสำหรับลงลายเซ็นไป RapidAPI โดยไม่ส่งคุกกี้ บันทึก `RAPIDAPI_KEY` เฉพาะใน `.env` ส่วนตัว แล้วรีสตาร์ต API/Compose ค่า `TIKTOK_STUDIO_*` ใน `.env.example` เป็นค่าเริ่มต้นสำหรับทดลอง อาจต้องปรับให้ตรงกับ LIVE Studio ของบัญชี การกดปุ่มสร้างห้องเป็นคำสั่งจริงต่อ TikTok; โค้ดยังผ่านเพียงการทดสอบจำลอง ไม่มีผลทดสอบสร้างห้องหรือยืนยันว่าผู้ชมเห็นคลิปจริง แม้สร้างห้องได้ การส่ง FFmpeg ตรงอาจต้องมีข้อมูลกำกับภาพที่ลงลายเซ็นด้วย จึงต้องทดสอบกับบัญชีและห้องจริงก่อนใช้เป็นระบบอัตโนมัติเต็มรูปแบบ

ตรวจระบบ:

```powershell
Invoke-RestMethod http://localhost:4000/health/ready
Invoke-RestMethod http://localhost:4000/api/v1/mock/live-stats
npm ci
npm run demo:event
docker compose logs worker --tail 20
```

`/health/ready` แสดงสถานะ PostgreSQL, Redis และ worker ตามจริง; `demo:event` ส่ง event จำลองให้ worker ทดสอบการเชื่อม โดยไม่สั่งงาน TikTok ปิดชุดบริการด้วย `docker compose down` ซึ่งยังเก็บข้อมูลใน volume ของ PostgreSQL ไว้

## รันแบบพัฒนา

```powershell
npm run setup:local
docker compose up -d postgres redis
npm ci
npm run dev
```

เว็บอยู่ที่ `localhost:3100`, API ที่ `localhost:4000`, PostgreSQL dev ที่ `localhost:5433`, Redis dev ที่ `localhost:6380` ใช้ `npm test`, `npm run lint`, `npm run format:check` และ `npm run build` เพื่อตรวจทุก workspace

## โครงสร้าง

- `apps/web` — Next.js/TypeScript UI, login สำหรับระบบใหม่นี้ และหน้า Dashboard, Accounts, Live Session, Video Library, Playlist, Product Set, Comment + AI, Analytics, Sales, Logs, Settings
- `apps/api` — backend API, healthcheck, สถานะ integration และ mock Live Stats/Product
- `apps/worker` — Redis heartbeat และตัวรับ event ที่ตรวจ shared contract ก่อนประมวลผล
- `packages/shared` — proposed event contracts v1, validator และ mock event factory
- `packages/tiktok-client` — client boundary และ mock transport ของ endpoint ที่ยังไม่ยืนยัน

## งานที่รอทีม

- **โอ๊ต P0-3:** นำ Schema v2 ที่ผ่าน review เข้า Prisma, รัน migration กับ Dev DB และส่งผลการตรวจ index/relation/constraint ฐาน PostgreSQL ใน Compose พร้อมแล้ว แต่ยังไม่มี migration จริง
- **ซีและภูมิ P0-5:** ยืนยัน Integration/Comment/Chat contracts และปรับ proposed request/response กับ event mapping ให้ตรงหลักฐานที่ตรวจแล้ว
- **น็อต P0-6 ขั้นถัดไป:** เสียบ verified transport หลังได้รับ endpoint และบัญชีทดสอบที่อนุมัติ; เพิ่ม unit/integration tests โดยไม่เปิดคำสั่งที่เปลี่ยนข้อมูลจริงก่อนพร้อม

คำสั่ง Add Product, Pin Product และ Chat ในโครงปัจจุบันเป็น mock/simulated เท่านั้น ระบบส่ง RTMP จาก MP4 ได้ และมีทางเลือกทดลองสร้างห้องผ่าน RapidAPI signer แต่ยังไม่ได้ยืนยันกับบัญชีจริง ข้อมูลบัญชีที่นำเข้าอยู่ในตารางแยก `livehub_account_imports` ซึ่ง API สร้างเมื่อใช้งาน เพื่อรอ Schema/Prisma ของโอ๊ต ระบบล็อกอินยังเป็นบัญชีท้องถิ่นเดียว ก่อนใช้งานนอกเครื่องหรือหลายคนต้องเพิ่ม users table, password hashing, rate limiting, audit log และการจัดการอายุคุกกี้

สมาชิกทีมดูจุดรับงาน วิธีสร้าง branch และข้อกำหนดข้อมูลลับใน [CONTRIBUTING.md](CONTRIBUTING.md)
ผลตรวจ Day 03 จากการติดตั้งใหม่และ Docker หลัง restart อยู่ใน [docs/day03-verification.md](docs/day03-verification.md)

สำหรับการย้ายไปทำต่อบนเครื่องอื่น ดู [คู่มือย้ายเครื่อง](transfer/README.md) และ [สรุปส่งต่องาน](docs/handoff-new-computer.md) ชุดสำรองเข้ารหัสอยู่ใน Git LFS; กุญแจถอดรหัสต้องรับและเก็บแยกจาก repo สาธารณะ
