export const sections = [
  ['dashboard', 'ภาพรวม', 'LayoutDashboard'],
  ['accounts', 'บัญชี', 'Users'],
  ['live', 'ไลฟ์', 'RadioTower'],
  ['videos', 'คลังวิดีโอ', 'Clapperboard'],
  ['playlists', 'เพลย์ลิสต์', 'ListVideo'],
  ['products', 'ชุดสินค้า', 'Package'],
  ['comments', 'คอมเมนต์ + AI', 'MessageSquare'],
  ['boxphone', 'Boxphone', 'Smartphone'],
  ['analytics', 'วิเคราะห์', 'ChartNoAxesCombined'],
  ['sales', 'ยอดขาย', 'ChartNoAxesCombined'],
  ['logs', 'บันทึกระบบ', 'ScrollText'],
  ['settings', 'ตั้งค่า', 'Settings'],
] as const;
export type Section = (typeof sections)[number][0];
export const accountRows = [
  { name: 'บัญชีตัวอย่าง A', handle: '@demo_shop_a', status: 'พร้อมใช้งาน', last: 'วันนี้ 09:30' },
  { name: 'บัญชีตัวอย่าง B', handle: '@demo_shop_b', status: 'รอตรวจสอบ', last: 'เมื่อวาน 16:45' },
];
export const videos = [
  { name: 'product-intro-01.mp4', duration: '00:42', size: '28 MB', status: 'พร้อมใช้' },
  { name: 'live-loop-02.mp4', duration: '01:15', size: '43 MB', status: 'พร้อมใช้' },
  { name: 'promo-short-03.mp4', duration: '00:30', size: '19 MB', status: 'กำลังตรวจสอบ' },
];
export const activities = [
  { time: '09:32', event: 'ซิงก์รายการสินค้า', module: 'Product Set', state: 'สำเร็จ' },
  { time: '09:20', event: 'สร้างเพลย์ลิสต์ตัวอย่าง', module: 'Playlist', state: 'สำเร็จ' },
  { time: '08:55', event: 'ตรวจสอบบัญชีตัวอย่าง B', module: 'Accounts', state: 'รอตรวจสอบ' },
];
