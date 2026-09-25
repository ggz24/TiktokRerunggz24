# 📄 Proposed Request Template: Stats & Products (Day 03)
**ผู้รับผิดชอบ:** ซี 

## 1. Field Mapping (TikTok Raw -> Internal DB v2)
| ข้อมูลดิบจาก TikTok (Raw) | ตัวแปรภายในระบบเรา (Internal DB v2) | ประเภทข้อมูล (Type) |
| :--- | :--- | :--- |
| `data.room_id` | `room_id` | String |
| `data.current_viewers` | `viewers` | Number |
| `data.total_viewers` | `enters` | Number |
| `data.gmv` | `gmv` | Number (Float) |
| `data.items_sold` | `sold` | Number |
| `data.impressions` | `impressions` | Number |
| *(คำนวณในระบบ: gmv / ชั่วโมง)* | `gmvPerHour` | Number (Float) |
| *(คำนวณในระบบ: impressions / ชั่วโมง)*| `impressionsPerHour` | Number |

## 2. JSON Fixtures (สำหรับทดสอบ Mocking ใน PO-6)

### 2.1 Live Stats Fixtures
**✅ Success Response (Normalized):**
```json
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
```
**❌ Error Response (Cookie หลุด):**
```json
{
  "status": "error",
  "error_code": 401,
  "message": "Unauthorized: Session expired or invalid cookie"
}
```

### 2.2 Product Search Fixtures
**✅ Success Response:**
```json
{
  "status": "success",
  "data": {
    "products": [
      { "product_id": "pid_001", "name": "เซรั่มบำรุงผิวหน้า", "price": 390.00 },
      { "product_id": "pid_002", "name": "ครีมกันแดดสูตรน้ำ", "price": 259.00 }
    ]
  }
}
```
**❌ Error Response:**
```json
{
  "status": "error",
  "error_code": 404,
  "message": "Product not found or invalid keyword"
}
```

### 2.3 Add Product Fixtures
**✅ Success Response:**
```json
{
  "status": "success",
  "message": "Product added to live shopping cart successfully",
  "data": { "product_id": "pid_001" }
}
```
**❌ Error Response:**
```json
{
  "status": "error",
  "error_code": 403,
  "message": "Forbidden: Room ID is not currently live"
}
```

### 2.4 Pin Product Fixtures
**✅ Success Response:**
```json
{
  "status": "success",
  "message": "Product pinned successfully",
  "data": { "pin_status": 1, "product_id": "pid_001" }
}
```
**❌ Error Response:**
```json
{
  "status": "error",
  "error_code": 400,
  "message": "Bad Request: Product is not in the live shopping cart"
}
```

## 3. สรุปจุดที่ยัง Pending Verification
*   **โครงสร้าง JSON ดิบ:** ต้องรอ Test Account เพื่อยิงเช็คจาก DevTools อีกครั้ง
*   **Rate Limit:** ต้องทดสอบยิง API ถี่ๆ เพื่อหาจุดที่ถูกบล็อก (HTTP 429)
*   **การตอบสนองเมื่อ Live ตัด:** ทดสอบ Endpoint Add/Pin เมื่อสตรีมหลุด
