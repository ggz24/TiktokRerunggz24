# Nott Day 03 — สิ่งที่ต้องแก้ก่อนปิดงาน

โครงการ: TikTok Live Manager / Live Hub<br>
ผู้รับผิดชอบ: Nott<br>
สถานะปัจจุบัน: **Progressing / Partial Pass**<br>
อ้างอิงจาก: `live-hub.zip` + ภาพหน้า `localhost:3100/settings`

---

## 1. แก้ Build/Test ของ TikTok Client ให้ผ่าน

### ปัญหาที่พบ
เมื่อรัน `npm test` จากไฟล์งานจริง:

- `@live-hub/shared` → **10/10 tests PASS**
- pipeline หยุดที่ `@live-hub/tiktok-client`
- Error:

```text
TS2688: Cannot find type definition file for 'node'
```

### สิ่งที่ต้องแก้
- ตรวจ `package.json` / workspace dependencies ของ `packages/tiktok-client`
- เพิ่มหรือแก้ `@types/node` ให้ TypeScript resolve ได้
- ตรวจ `tsconfig.json` ว่าอ้าง `types: ["node"]` ถูกต้องและ package ถูกติดตั้งจริง
- รัน test/build ใหม่ทั้ง monorepo

### หลักฐานที่ต้องส่ง
- ผล `npm test` รอบใหม่
- ผล build ของ `@live-hub/tiktok-client`
- screenshot หรือ terminal log ที่แสดงว่า test suite ผ่านครบ

### เกณฑ์ผ่าน
```text
npm test → PASS ทั้ง workspace
```

---

## 2. เพิ่ม ESLint และ Prettier ให้ครบตาม P0-2

### ปัญหาที่พบ
ใน ZIP ที่ตรวจ **ยังไม่พบ config ของ ESLint / Prettier** ทั้งที่ P0-2 กำหนดไว้

### สิ่งที่ต้องแก้
เพิ่ม config ที่ root หรือ workspace level เช่น:

```text
eslint.config.*
.prettierrc
.prettierignore
```

และเพิ่ม script ใน `package.json` เช่น:

```json
{
  "scripts": {
    "lint": "...",
    "format:check": "..."
  }
}
```

### หลักฐานที่ต้องส่ง
- ไฟล์ config
- ผล `npm run lint`
- ผล `npm run format:check`

### เกณฑ์ผ่าน
- lint ผ่าน
- format check ผ่าน
- ไม่มี error ระดับ block

---

## 3. Sync Shared Event Contract ให้ตรง Scope กลาง

### ปัญหาที่พบ
`packages/shared` มี implementation และ test จริงแล้ว แต่ชื่อ event บางส่วนยังไม่ตรง contract กลาง

### Event ที่ Scope กำหนด
ต้องรองรับอย่างน้อย:

```text
live.starting
live.started
live.stopped
live.error

stats.updated

comment.received

chat.send.request
chat.sent
chat.failed
```

### จุดที่พบใน code ปัจจุบัน
มีชื่อ event เช่น:

```text
viewer.entered
reaction.liked
chat.send.requested
```

ซึ่งยังไม่ตรงกับ contract กลางทั้งหมด

### สิ่งที่ต้องแก้
- Freeze event names ตาม Shared Contract
- ถ้าต้องการ event เพิ่ม สามารถมีได้ แต่ห้ามแทนชื่อ contract หลัก
- ปรับ type/schema/validator/test fixture ให้ตรงกัน
- ตรวจ consumer ฝั่ง worker/API ว่าใช้ชื่อเดียวกัน

### Payload สำคัญที่ต้องรักษา

```ts
live.started {
  accountId,
  roomId,
  streamStartedAt
}

live.stopped {
  accountId,
  reason
}

stats.updated {
  accountId,
  gmv,
  sold,
  viewers,
  enters,
  impressions,
  gmvPerHour,
  impressionsPerHour
}

comment.received {
  accountId,
  user,
  text,
  type // comment | enter | like | gift
}

chat.send.request {
  accountId,
  text
}
```

### หลักฐานที่ต้องส่ง
- shared event type definitions
- validator/schema
- unit tests
- fixture ตัวอย่างแต่ละ event

### เกณฑ์ผ่าน
- event names ตรง contract
- payload validate ผ่าน
- test ผ่านครบ

---

## 4. P0-2 ต้องมีหลักฐาน Runtime/Compose ครบ

### สิ่งที่เห็นแล้วจากภาพ
หน้า `/settings` แสดงว่า:

- PostgreSQL → เชื่อมต่อแล้ว
- Redis → เชื่อมต่อแล้ว
- Worker heartbeat → ทำงาน
- Prisma Migration v2 → ยังรอเชื่อม
- TikTok API → รอยืนยัน Endpoint
- Comment / Chat Contract → รอเชื่อม

### สิ่งที่ยังต้องมีเป็น evidence
- `docker compose up` หรือ equivalent
- healthcheck ของ API
- healthcheck ของ Web
- Redis connection
- PostgreSQL connection
- Worker heartbeat
- service status หลัง restart 1 รอบ

### เกณฑ์ผ่าน P0-2
Monorepo + Docker stack ขึ้นได้และ service หลักตอบสนองครบ

---

## 5. Prisma Migration ยังห้ามนับว่า Done

### สถานะปัจจุบัน
หน้า settings แสดง:

```text
Prisma Migration v2 — รอเชื่อม
```

ดังนั้นยังไม่มีหลักฐานว่า migration ผ่านจริง

### สิ่งที่ต้องทำร่วมกับ Oat
หลัง Oat นำ `schema.prisma` / migration เข้า monorepo:

1. ต่อ Dev PostgreSQL
2. รัน migration
3. generate Prisma Client
4. ตรวจ relation / index / constraint
5. restart API
6. รัน smoke test

### หลักฐานที่ต้องส่ง
- migration output
- generated migration files
- Prisma Client generation result
- smoke test หลัง migrate

### เกณฑ์ผ่าน
```text
Prisma migrate PASS
API start PASS
DB relation/index/constraint ถูกต้อง
```

---

## 6. P0-6 TikTok Client — ตอนนี้นับเป็น Skeleton เท่านั้น

### สิ่งที่พบ
มี package:

```text
packages/tiktok-client
```

และมีการแยก abstraction / facade ออกจาก transport

ถือว่าแนวทางถูกต้อง แต่ยังไม่ควร claim ว่า P0-6 Done

### สิ่งที่ต้องมีเพิ่มก่อนปิด P0-6
- cURL/parser input → normalized request template
- dynamic substitution:
  - room id
  - creator/account id
  - cookie placeholder
- HTTP proxy support
- SOCKS5 proxy support
- retry/backoff
- unit tests สำหรับ parser
- unit tests สำหรับ proxy config
- secret redaction

### ข้อจำกัด
Endpoint ที่ C/Phum ยังระบุ `Pending verification` ต้องคงสถานะนั้นไว้<br>
ห้าม hardcode หรือ claim ว่าเป็น verified endpoint ถ้ายังไม่มี DevTools evidence จริง

---

## 7. ห้ามใช้ Secret จริงใน Repo / Evidence

ห้ามใส่ข้อมูลต่อไปนี้ลง repo, log, screenshot หรือ test fixture:

```text
TikTok Cookie
Session ID
Access Token
Refresh Token
CSRF Token
Production credential
Customer data
```

ใช้ placeholder เช่น:

```text
<COOKIE>
<REDACTED>
<ACCESS_TOKEN>
<ROOM_ID>
```

หากจะใช้บัญชี TikTok test จริง / cookie จริง / เปิด Live จริง ต้องได้รับอนุมัติจาก Get หรือ Owner ก่อน

---

## ลำดับแก้ที่แนะนำ

1. แก้ `@types/node` / TypeScript build
2. รัน `npm test` ให้ผ่านทั้ง repo
3. เพิ่ม ESLint + Prettier
4. Sync Shared Event Contract
5. รวม Prisma migration ของ Oat
6. รัน integration test ของ stack
7. ส่ง PR/commit + evidence
8. ค่อยเดิน P0-6 ต่อจาก Mock/Fixture

---

## สถานะหลังตรวจ

| Task | สถานะ |
|---|---|
| P0-2 Monorepo / Dev Foundation | 🟡 เกือบผ่าน / ยังขาด test+lint evidence |
| P0-3 Prisma Migration | ⏳ รอ Oat + migration จริง |
| P0-4 Shared Contract | 🟡 มี implementation แต่ต้อง sync event names |
| P0-5 Integration Research | 🟡 ใช้เป็น input ได้ แต่ real endpoint ยัง Pending |
| P0-6 TikTok Client | 🟡 Skeleton มีแล้ว แต่ build/test ยังไม่ผ่าน |

---

## Definition of Done สำหรับรอบแก้

ถือว่ารอบแก้ผ่านเมื่อมีหลักฐานครบ:

- `npm test` ผ่านทั้ง monorepo
- `npm run lint` ผ่าน
- `npm run format:check` ผ่าน
- Shared Event Contract ตรงกับ scope
- Docker stack ขึ้นครบ
- Postgres / Redis / Worker health ผ่าน
- Prisma migration ผ่าน
- PR/commit พร้อมให้ Nott review ทางเทคนิค
- ไม่มี secret จริงใน repo/evidence

> หมายเหตุ: การผ่านรายการนี้ยังเป็น **Dev/Test readiness** เท่านั้น ไม่ใช่ Production approval
