# ย้ายโปรเจกต์ไปเครื่องใหม่

`2026-09-28-current-state.enc` เป็นชุดสำรองล่าสุดที่เข้ารหัสด้วย AES-256-GCM และเก็บผ่าน Git LFS ภายในมี `.env` ที่ใช้กับเว็บปัจจุบัน (รวม RapidAPI key), PostgreSQL dump และ MP4 ที่อัปโหลดไว้ 1 ไฟล์ กุญแจถอดรหัส `livehub-2026-09-28.key` ต้องเก็บแยกจาก Git; ไฟล์นี้ไม่ได้อยู่ใน repo

`2026-09-25-full-state.enc` เป็นชุดสำรองเก่าที่เก็บไว้เพื่ออ้างอิง กุญแจของชุดเก่าแยกจากกุญแจของชุดล่าสุด

## เตรียมเครื่อง

ติดตั้ง Git, Git LFS, Node.js 22 และ Docker Desktop จากนั้น clone repo และรัน `git lfs pull` ในโฟลเดอร์โปรเจกต์ ตรวจว่าไฟล์ชุดล่าสุดมีขนาดประมาณ 529 MB ถ้าได้ไฟล์ข้อความเล็ก ๆ ให้ตรวจ Git LFS ก่อนดำเนินการ

## กู้คืนบน Windows PowerShell

เริ่มจาก repo ที่ clone ใหม่และฐานข้อมูลว่าง นำกุญแจ 64 หลักของชุดวันที่ 28 ที่ได้รับแยกต่างหากไปเก็บในไฟล์นอก repo โดยไม่พิมพ์กุญแจไว้ในประวัติคำสั่ง:

```powershell
$keyText = Read-Host 'วางกุญแจสำรอง 64 หลัก'
[System.IO.File]::WriteAllText((Join-Path $env:USERPROFILE 'livehub-2026-09-28.key'), $keyText.Trim())
Remove-Variable keyText

node scripts/transfer-vault.mjs decrypt transfer/2026-09-28-current-state.enc (Join-Path $env:TEMP 'livehub-transfer.tar') (Join-Path $env:USERPROFILE 'livehub-2026-09-28.key')
New-Item -ItemType Directory -Path 'transfer-restored' | Out-Null
tar.exe -xf (Join-Path $env:TEMP 'livehub-transfer.tar') -C 'transfer-restored'
Copy-Item -LiteralPath 'transfer-restored/live-hub.env' -Destination '.env'
npm run setup:local
docker compose up -d postgres redis
$containerId = docker compose ps -q postgres
docker cp 'transfer-restored/database/livehub.dump' "${containerId}:/tmp/livehub.dump"
docker exec $containerId pg_restore -U livehub -d livehub --no-owner --no-privileges /tmp/livehub.dump
docker compose up --build -d
$apiContainer = docker compose ps -q api
docker cp 'transfer-restored/media/.' "${apiContainer}:/app/media"
docker compose ps
```

เปิด `http://localhost:3100` และเข้าสู่ระบบด้วย `APP_USERNAME` / `APP_PASSWORD` จาก `.env` ที่กู้คืน การเชื่อมต่อ TikTok อาจหมดอายุตามอายุ session ของแพลตฟอร์ม; หากเป็นเช่นนั้นให้คัดลอก cURL ใหม่จากบัญชีที่มีสิทธิ์ใช้งาน

หลังตรวจว่าเว็บ บัญชี และ MP4 กลับมาครบแล้ว ลบ `transfer-restored` และ `livehub-transfer.tar` ที่เป็นข้อมูลไม่เข้ารหัส เก็บไฟล์กุญแจนอก repo และอย่าส่งให้คนอื่นผ่าน issue หรือ commit

ถ้าต้องการเริ่มโปรเจกต์ใหม่โดยไม่ย้ายบัญชีเดิม ให้ข้ามชุดสำรองนี้แล้วทำตาม [README หลัก](../README.md) ด้วย `npm run setup:local`
