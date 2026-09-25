Integration Research (Stats & Products)
เวอร์ชันอัปเดต Day 02
ผู้รับผิดชอบ: ซี (Day 02)

1. ตารางสรุป Endpoint (Status)
Feature
Endpoint Path
Method
Status
หมายเหตุ
Live Stats
/api/live/detail/core/stats
GET
Pending verification
รออนุมัติบัญชีทดสอบเพื่อดึงจาก DevTools
Search Product
/api/product/search_product
GET
Pending verification
รออนุมัติบัญชี Seller ทดสอบ
Add Product
/api/live/add_product
POST
Pending verification
ต้องทดสอบระหว่างมีห้องไลฟ์จริง
Pin Product
/api/live/pin_product
POST
Pending verification
ต้องทดสอบระหว่างมีห้องไลฟ์จริง


2. cURL / DevTools Evidence (Sanitized) & Request/Response Shape
หมายเหตุ: ข้อมูลอ้างอิงจากโครงสร้างมาตรฐานเพื่อเตรียมความพร้อมให้ฝั่ง Database โดยลบ Cookie และ Secret ทั้งหมดออกตามข้อกำหนดด้านความปลอดภัย
2.1 Live Stats — สถิติการไลฟ์
Endpoint
GET /api/live/detail/core/stats
cURL Evidence (Sanitized)
curl -X GET "https://api.tiktok.com/api/live/detail/core/stats?room_id=[ROOM_ID]&creator_id=[CREATOR_ID]" \
-H "Cookie: [REDACTED_SECRET]" \
-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)..."

Response Shape
โครงสร้าง Response ได้ปรับให้ครอบคลุมตาม Scope ของ DB V2
{
  "status_code": 0,
  "data": {
    "room_id": "string",
    "viewers": "number",
    "enters": "number",
    "gmv": "number",
    "sold": "number",
    "impressions": "number",
    "gmvPerHour": "number",
    "impressionsPerHour": "number"
  }
}


2.2 Search Product — ค้นหาสินค้า
Endpoint
GET /api/product/search_product
cURL Evidence (Sanitized)
curl -X GET "https://seller-th.tiktok.com/api/product/search_product?keyword=[KEYWORD]" \
-H "Cookie: [REDACTED_SECRET]"

Response Shape
{
  "status_code": 0,
  "data": {
    "products": [
      {
        "product_id": "string",
        "name": "string",
        "price": "number"
      }
    ]
  }
}


2.3 Add Product — เพิ่มสินค้าเข้าไลฟ์
Endpoint
POST /api/live/add_product
cURL Evidence (Sanitized)
curl -X POST "https://seller-th.tiktok.com/api/live/add_product" \
-H "Cookie: [REDACTED_SECRET]" \
-H "Content-Type: application/json" \
-d '{"room_id":"[ROOM_ID]","product_id":"[PRODUCT_ID]"}'


2.4 Pin Product — ปักหมุดสินค้า
Endpoint
POST /api/live/pin_product
cURL Evidence (Sanitized)
curl -X POST "https://seller-th.tiktok.com/api/live/pin_product" \
-H "Cookie: [REDACTED_SECRET]" \
-H "Content-Type: application/json" \
-d '{"room_id":"[ROOM_ID]","product_id":"[PRODUCT_ID]"}'


3. ข้อสังเกตและข้อจำกัดเพิ่มเติม (Integration Notes)
3.1 การปรับปรุงโครงสร้างข้อมูลสำหรับโอ๊ต
โครงสร้างของ Stats ในข้อ 2.1 ได้ปรับเพิ่มฟิลด์ดังต่อไปนี้ เพื่อให้สอดคล้องกับการปรับ DB Schema Draft (v2) ของโอ๊ตแล้ว
enters
gmvPerHour
impressionsPerHour
3.2 Rate Limit & Request Delay
การดึงข้อมูลจาก core/stats ควรตั้งเวลาหน่วงประมาณ 5–10 วินาทีต่อการ Request 1 ครั้ง เพื่อลดความเสี่ยงจากการถูกจำกัดการเข้าถึง (Rate Limit)
3.3 เงื่อนไขการใช้งาน
การยืนยัน (Verification) ของ Endpoint ในหมวด Live ได้แก่
Live Stats
Add Product
Pin Product
ไม่สามารถดำเนินการยืนยันได้หากบัญชีทดสอบไม่ได้กำลังสตรีมอยู่จริง
ดังนั้น จำเป็นต้องรอให้บัญชีทดสอบได้รับการอนุมัติก่อน จึงจะสามารถดึงข้อมูลจาก DevTools ของจริง และเปลี่ยนสถานะ Endpoint จาก Pending verification เป็น Verified ได้

4. สถานะปัจจุบัน
รายการ
สถานะ
Live Stats
🟡 Pending verification
Search Product
🟡 Pending verification
Add Product
🟡 Pending verification
Pin Product
🟡 Pending verification

Next Step: รอการอนุมัติบัญชีทดสอบ จากนั้นดำเนินการตรวจสอบ Endpoint ผ่าน DevTools และอัปเดตหลักฐาน Request/Response ให้เป็นข้อมูลจากระบบจริง 

