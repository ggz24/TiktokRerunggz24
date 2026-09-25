# 📄 Integration Research: Stats & Products (Day 01)
**ผู้รับผิดชอบ:** ซี (Day 01)

## 1. รายการ Endpoint และโครงสร้าง Request/Response
*(หมายเหตุ: ข้อมูลความลับ เช่น Cookie และ Token ถูก Redacted ตามข้อกำหนด)*

### 1.1 Endpoint: Live Stats (สถิติการไลฟ์)
* **Method:** `GET`
* **URL:** `https://api.tiktok.com/api/live/detail/core/stats`
* **Required Parameters (Dynamic):**
  * `room_id`: ไอดีของห้องไลฟ์ที่ต้องการดึงสถิติ
  * `creator_id`: ไอดีของผู้สร้าง (Creator)
* **Response Structure:**
```json
{
  "total_viewers": 1250,
  "current_viewers": 450,
  "gmv": 25400.75,
  "items_sold": 82
}

1.2 Endpoint: search_product (ค้นหาสินค้า)
Method: GET

URL: [https://seller-th.tiktok.com/api/product/search_product](https://seller-th.tiktok.com/api/product/search_product)

Parameter: keyword (ชื่อสินค้าที่ต้องการค้นหา)

Response Structure:
{
  "products": [
    { "product_id": "pid_001", "name": "Product A", "price": 299 },
    { "product_id": "pid_002", "name": "Product B", "price": 450 }
  ]
}
1.3 Endpoint: add_product (เพิ่มสินค้าเข้าไลฟ์)
Method: POST

URL: [https://seller-th.tiktok.com/api/live/add_product](https://seller-th.tiktok.com/api/live/add_product)

Payload (JSON): room_id, product_id

Response Structure:
{
  "status_code": 0,
  "message": "success"
}
1.4 Endpoint: pin_product (ปักหมุดสินค้า)
Method: POST

URL: [https://seller-th.tiktok.com/api/live/pin_product](https://seller-th.tiktok.com/api/live/pin_product)

Payload (JSON): room_id, product_id

Response Structure:
{
  "status_code": 0,
  "message": "pinned successfully",
  "data": { "pin_status": 1 }
}

2. สรุปข้อสังเกตและข้อจำกัด (Integration Notes)
สถานะห้องไลฟ์: API จะทำงานได้ต่อเมื่อมี room_id ที่กำลัง Active เท่านั้น

Rate Limit: สำหรับ Stats ควรหน่วงเวลาดึงข้อมูล (Polling) ทุกๆ 5-10 วินาที

การจัดการ Session: ต้องมีระบบแจ้งเตือนเมื่อ Cookie หมดอายุเพื่อให้ผู้ใช้อัปเดตได้ทันที
