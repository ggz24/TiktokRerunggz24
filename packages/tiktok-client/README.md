# TikTok Client skeleton (P0-6)

โครงเชื่อมต่อของน็อตสำหรับ backend/worker เท่านั้น ปัจจุบันเป็น **mock ภายในเครื่อง** และไม่ติดต่อ TikTok, ไม่มี URL endpoint, cookie หรือข้อมูลรับรองจากระบบต้นทาง

## ส่วนที่พร้อมใช้

- `createTikTokClient(transport)` รวมโมดูล `auth.status`, `stats.live`, `products.search/add/pin`, `comments.list`, `chat.send`
- `createMockTransport()` คืนข้อมูลตัวอย่างและ error แบบกำหนดแน่นอน ใช้พัฒนา API/UI และทดสอบ flow
- ทุกผลลัพธ์จาก mock มี `source: "mock"` และ `verification.status: "pending_verification"`
- คำสั่ง add/pin/chat จาก mock มี `execution: "simulated"` ไม่มีผลกับไลฟ์จริง
- Mock Live Stats มี `sold` สำหรับ shared `stats.updated` contract

## เครื่องมือเตรียม adapter (ยังไม่เชื่อม TikTok)

- `parseSanitizedCurl()` อ่านตัวอย่าง cURL ที่ลบข้อมูลลับแล้วเป็น request template; รองรับ JSON และ form body, แทนชื่อ field ที่รู้จักด้วย `<ROOM_ID>`, `<ACCOUNT_ID>`, `<CREATOR_ID>`, `<COOKIE>`, `<ACCESS_TOKEN>` หรือ `<REDACTED>` และคงสถานะ `pending_verification`
- `substituteRequestTemplate()` เติม room/account/creator ID และ cookie ในหน่วยความจำ เพื่อใช้ตรวจ mapping; ไม่ส่ง HTTP request และผลลัพธ์ที่เติม cookie แล้วห้ามบันทึกลง log หรือ fixture
- `redactRequestForLog()` ซ่อน URL path, query, body และค่า header ก่อนบันทึก log
- `parseProxyConfig()` ตรวจ URL ของ HTTP/HTTPS/SOCKS5/SOCKS5H proxy โดยไม่รับ credential ใน URL; ยังไม่มี network agent หรือการเชื่อม proxy จริง
- `nextRetryDelayMs()` คำนวณ exponential backoff แบบ pure function เฉพาะเมื่อ caller ระบุว่าเป็นงานที่ retry ได้และ idempotent; ยังไม่มีการส่ง request หรือ retry อัตโนมัติ
- `parseAccountImportCurl()` อ่าน cURL **จริงที่ผู้ใช้วางในฟอร์มตอนรันแอป** สำหรับคำขอ `HEAD https://www.tiktok.com/api/update/profile/` เท่านั้น; คืน cookie ให้ backend ใช้ในหน่วยความจำ และไม่รัน shell หรือส่ง request เอง รับเฉพาะข้อความดิบจาก DevTools ไม่รับ URL ที่ถูกแปลงเป็นลิงก์ Markdown

เมื่อเปิด flow เพิ่มบัญชีจริง backend ต้องเก็บ cookie ที่รับมาด้วยวิธีเข้ารหัสและจำกัดสิทธิ์ ห้ามส่งค่าไป browser อีกหลังบันทึก ห้ามเขียนลง log/test/fixture/repo และต้องตรวจบัญชีกับ TikTok ก่อนแสดงว่าเชื่อมแล้ว ข้อมูลที่ผู้ใช้วางในแชทไม่ถูกนำไปใส่ source code

ตัวอย่างที่ปลอดภัยสำหรับพัฒนาในเครื่อง:

```ts
import { parseSanitizedCurl, substituteRequestTemplate, redactRequestForLog } from '@live-hub/tiktok-client';

const template = parseSanitizedCurl(
  "curl 'https://example.invalid/live?room_id=<ROOM_ID>' -H 'Cookie: <COOKIE>'",
);
const prepared = substituteRequestTemplate(template, {
  roomId: 'demo-room',
  cookie: '<COOKIE>',
});
const safeLog = redactRequestForLog(prepared);
```

ตัว parser ไม่รัน shell/cURL และไม่ตรวจได้ว่าข้อมูลใน field ที่ไม่รู้จักเป็นข้อมูลส่วนตัวหรือไม่ จึงต้องส่งเข้า parser เฉพาะตัวอย่างที่ sanitize แล้ว ห้ามใส่ cookie, token, บัญชีลูกค้า หรือหลักฐานจริงลง source/test/repo

```ts
import { createMockTransport, createTikTokClient } from "@live-hub/tiktok-client";

const client = createTikTokClient(createMockTransport());
const result = await client.stats.live({
  accountId: "demo-account-1",
  liveSessionId: "demo-live-1",
});
```

## จุดส่งต่องาน

- **ซี:** ตรวจ endpoint/response ของ Live Stats และ Product จริงก่อน แล้วสร้าง transport adapter ที่ทำตาม `TikTokTransport` ใน `src/types.ts` ฟิลด์ Stats ที่เตรียมไว้รวม `enters`, `gmvPerHour`, `impressionsPerHour`
- **ภูมิ:** ตรวจ Comment/Chat contract และตัวอย่าง event ก่อนสร้าง adapter และ mapping ไป shared event package
- **โอ๊ต:** ให้ backend แปลง normalized response เป็น DB record และ shared event ตาม schema ที่อนุมัติ ห้ามใช้ fixture เป็นข้อมูล Production
- **น็อต:** เพิ่ม adapter, unit tests สำหรับการแปลง response, health/error mapping และหลักฐานการทดสอบ หลังได้บัญชีทดสอบที่อนุมัติแล้ว

ชื่อ operation และ shape ในแพ็กเกจนี้เป็น **สัญญาภายในสำหรับทดลอง** ยังไม่ใช่หลักฐานว่า TikTok API มี endpoint ตามนี้ การเชื่อมจริงต้องทบทวนจากเอกสาร Integration ของซี/ภูมิ และเปลี่ยนสถานะเป็น `verified` เฉพาะรายการที่มีหลักฐานทดสอบ

## ทดสอบ

จากโฟลเดอร์นี้รัน `npm test` (ต้องติดตั้ง dependencies ของ workspace แล้ว) หรือจาก root `npm run test --workspace @live-hub/tiktok-client`
