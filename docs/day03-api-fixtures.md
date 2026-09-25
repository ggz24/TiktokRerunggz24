Proposed Request Template: Stats & Products (Day 03)
ผู้รับผิดชอบ: ซี
สถานะ: Proposed Request Template
หมายเหตุ: เปลี่ยนชื่อจาก PO-5 เป็น Proposed Request Template ตามบรีฟ Day 03

1. Field Mapping
TikTok Raw → Internal DB v2
ตารางด้านล่างแสดงการแปลงข้อมูลดิบจาก TikTok (Raw Data) ให้สอดคล้องกับ Normalized Stats Contract (DB v2) ของโอ๊ต
ข้อมูลดิบจาก TikTok (Raw)
ตัวแปรภายในระบบ (Internal DB v2)
ประเภทข้อมูล (Type)
data.room_id
room_id
String
data.current_viewers
viewers
Number
data.total_viewers
enters
Number
data.gmv
gmv
Number (Float)
data.items_sold
sold
Number
data.impressions
impressions
Number
คำนวณจาก gmv / ชั่วโมง
gmvPerHour
Number (Float)
คำนวณจาก impressions / ชั่วโมง
impressionsPerHour
Number


2. JSON Fixtures
สำหรับทดสอบใน PO-6
2.1 Live Stats Fixtures
✅ Success Response — Normalized
{
  "status": "success",
  "data": {
    "room_id": "7123456789012345",
    "viewers": 450,
    "enters": 1250,
    "gmv": 25400.75,
    "sold": 82,
    "impressions": 15000,
    "gmvPerHour": 12700.37,
    "impressionsPerHour": 7500
  }
}

❌ Error Response — Unauthorized
ตัวอย่างกรณี Cookie หลุด หรือ API มีการเปลี่ยนแปลง
{
  "status": "error",
  "error_code": 401,
  "message": "Unauthorized: Session expired or invalid cookie"
}


2.2 Product Search Fixtures
✅ Success Response
{
  "status": "success",
  "data": {
    "products": [
      {
        "product_id": "pid_001",
        "name": "เซรั่มบำรุงผิวหน้า",
        "price": 390.00
      },
      {
        "product_id": "pid_002",
        "name": "ครีมกันแดดสูตรน้ำ",
        "price": 259.00
      }
    ]
  }
}

❌ Error Response — Product Not Found
{
  "status": "error",
  "error_code": 404,
  "message": "Product not found or invalid keyword"
}


2.3 Add Product Fixtures
✅ Success Response
{
  "status": "success",
  "message": "Product added to live shopping cart successfully",
  "data": {
    "product_id": "pid_001"
  }
}

❌ Error Response — Live Room Not Active
{
  "status": "error",
  "error_code": 403,
  "message": "Forbidden: Room ID is not currently live"
}


2.4 Pin Product Fixtures
✅ Success Response
{
  "status": "success",
  "message": "Product pinned successfully",
  "data": {
    "pin_status": 1,
    "product_id": "pid_001"
  }
}

❌ Error Response — Product Not in Cart
{
  "status": "error",
  "error_code": 400,
  "message": "Bad Request: Product is not in the live shopping cart"
}


3. สรุปจุดที่ยัง Pending Verification
ปัจจุบันยังไม่มี Test Account ที่ได้รับการอนุมัติ ทำให้การเชื่อมต่อกับระบบจริงยังอยู่ในสถานะ Pending Verification
ประเด็นที่ต้องรอตรวจสอบจากการทดสอบจริง มีดังนี้
3.1 โครงสร้าง JSON ดิบของ TikTok
โครงสร้าง Raw Data อาจมีการเปลี่ยนแปลง เช่น Key Name หรือรูปแบบข้อมูล จึงต้องรอ Test Account เพื่อทดสอบและตรวจสอบข้อมูลจริงผ่าน DevTools อีกครั้ง
3.2 Rate Limit
ต้องทดสอบการเรียก Stats API ในความถี่ต่าง ๆ เพื่อระบุจุดที่ระบบของ TikTok เริ่มจำกัดการเรียกใช้งาน เช่น
HTTP 429 — Too Many Requests
3.3 การตอบสนองเมื่อ Live ตัด
ต้องทดสอบกรณีที่ Live Stream หยุดหรือหลุดกะทันหัน เพื่อยืนยันว่า Endpoint สำหรับ Add Product และ Pin Product จะส่ง Error Code และ Response รูปแบบใดกลับมา

4. สถานะโดยรวม
รายการ
สถานะ
Field Mapping
✅ Prepared
Success Fixtures
✅ Prepared
Error Fixtures
✅ Prepared
Integration Test
⏳ Pending Verification
Test Account
⏳ รอการอนุมัติ
Raw Data Verification
⏳ Pending
Rate Limit Verification
⏳ Pending
Live Disconnect Test
⏳ Pending

Next Step: เมื่อได้รับ Test Account แล้ว ให้ดำเนินการตรวจสอบ Raw Data, API Response, Rate Limit และกรณี Live Stream Disconnect ก่อนนำไปเชื่อมต่อกับระบบจริง


