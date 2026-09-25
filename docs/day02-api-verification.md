# 📄 Integration Research (Stats & Products) - เวอร์ชันอัปเดต Day 02
**ผู้รับผิดชอบ:** ซี (Day 02)

## 1. ตารางสรุป Endpoint (Status)
| Feature | Endpoint Path | Method | Status | หมายเหตุ |
| :--- | :--- | :--- | :--- | :--- |
| **Live Stats** | `/api/live/detail/core/stats` | GET | **Pending verification** | รออนุมัติบัญชีทดสอบเพื่อดึงจาก DevTools |
| **Search Product** | `/api/product/search_product` | GET | **Pending verification** | รออนุมัติบัญชี Seller ทดสอบ |
| **Add Product** | `/api/live/add_product` | POST | **Pending verification** | ต้องทดสอบระหว่างมีห้องไลฟ์จริง |
| **Pin Product** | `/api/live/pin_product` | POST | **Pending verification** | ต้องทดสอบระหว่างมีห้องไลฟ์จริง |

## 2. cURL / DevTools Evidence (Sanitized) & Request/Response Shape

### 2.1 Live Stats (สถิติการไลฟ์)
**cURL Evidence (Sanitized):**
```bash
curl -X GET "https://api.tiktok.com/api/live/detail/core/stats?room_id=[ROOM_ID]&creator_id=[CREATOR_ID]" \
-H "Cookie: [REDACTED_SECRET]"
```
**Response Shape (อัปเดตให้ครอบคลุม DB V2):**
```json
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
```

### 2.2 Search Product (ค้นหาสินค้า)
**cURL Evidence (Sanitized):**
```bash
curl -X GET "https://seller-th.tiktok.com/api/product/search_product?keyword=[KEYWORD]" \
-H "Cookie: [REDACTED_SECRET]"
```
**Response Shape:**
```json
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
```

### 2.3 Add Product (เพิ่มสินค้าเข้าไลฟ์)
**cURL Evidence (Sanitized):**
```bash
curl -X POST "https://seller-th.tiktok.com/api/live/add_product" \
-H "Cookie: [REDACTED_SECRET]" \
-H "Content-Type: application/json" \
-d '{"room_id":"[ROOM_ID]","product_id":"[PRODUCT_ID]"}'
```

### 2.4 Pin Product (ปักหมุดสินค้า)
**cURL Evidence (Sanitized):**
```bash
curl -X POST "https://seller-th.tiktok.com/api/live/pin_product" \
-H "Cookie: [REDACTED_SECRET]" \
-H "Content-Type: application/json" \
-d '{"room_id":"[ROOM_ID]","product_id":"[PRODUCT_ID]"}'
```

## 3. ข้อสังเกตและข้อจำกัดเพิ่มเติม (Integration Notes)
1. **การปรับปรุงโครงสร้างข้อมูล:** โครงสร้างของ Stats ในข้อ 2.1 ได้ปรับเพิ่มฟิลด์ `enters`, `gmvPerHour`, และ `impressionsPerHour`
2. **Rate Limit & Request Delay:** การดึง `core/stats` ควรตั้งเวลาหน่วงอย่างน้อย 5-10 วินาทีต่อการยิง 1 ครั้ง
3. **เงื่อนไขการใช้งาน:** การยืนยัน (Verification) ต้องรอให้บัญชีทดสอบได้รับอนุมัติก่อน
