# ส่งต่องานสำหรับเครื่องใหม่

## เริ่มงาน

Clone repo `https://github.com/notza0816581058/Tiktok-rerun` และเลือก branch `main` ใช้ [README หลัก](../README.md) สำหรับการรัน หรือ [คู่มือย้ายเครื่อง](../transfer/README.md) หากต้องกู้คืนบัญชีและไฟล์อ้างอิงจากเครื่องเดิม

โปรเจกต์เป็น monorepo: Next.js/TypeScript ที่ `apps/web`, API ที่ `apps/api`, worker ที่ `apps/worker`, event contracts ที่ `packages/shared`, และ client/fixtures ที่ `packages/tiktok-client` Compose เปิดเว็บที่ `localhost:3100` และ API ที่ `localhost:4000`

## สถานะงาน

- UI มี Dashboard, Accounts, Live Session, Video Library, Playlist, Product Set, Comment + AI, Analytics, Logs และ Settings หน้าที่นอกเหนือจากการนำเข้าบัญชียังใช้ข้อมูลจำลอง
- Accounts รับ cURL ที่เจ้าของบัญชีคัดลอกจาก DevTools ตรวจตัวตนผ่านคำขออ่านข้อมูลบัญชีของ TikTok แล้วเก็บ cookie และ User-Agent แบบเข้ารหัสใน PostgreSQL ไม่บันทึกค่าจริงใน Git
- ตาราง `livehub_account_imports` เป็นพื้นที่เก็บชั่วคราวก่อนรวมกับ Prisma schema ของโอ๊ต บัญชีที่มีอยู่ในชุดสำรองต้องใช้ `.env` จากชุดเดียวกันเพื่อถอดรหัส
- งานซีด้าน Stats/Product และงานภูมิด้าน Comments/Chat ยังต้องยืนยัน contract และเชื่อม endpoint จริง งาน client ของน็อตส่วน Live/Product/Chat ยังเป็น mock

เอกสารทีมอยู่ใน `docs/` รวมถึง [รายการแก้ Day 03](reference/Nott_Day03_Fix_List.md) และ [ขอบเขตโครงการ](reference/project_scope_tiktok_live_manager.md)

## ตรวจหลัง clone

```powershell
npm ci
npm test
npm run lint
npm run build
```

แชท Codex ที่ทำงานบนเครื่องเดิมอาจไม่ปรากฏเป็นงานเดียวกันบนเครื่องใหม่ ให้ใช้เอกสารนี้เริ่มงานต่อ หรือใช้ Remote/handoff ของ Codex เมื่อเชื่อมทั้งสองเครื่องกับบัญชีและโปรเจกต์เดียวกันแล้ว
