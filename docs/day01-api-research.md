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

URL: https://seller-th.tiktok.com/api/product/search_product

Parameter: keyword (ชื่อสินค้าที่ต้องการค้นหา)

Response Structure:
