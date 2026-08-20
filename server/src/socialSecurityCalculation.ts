// ประกันสังคม (มาตรา 33): เงินสมทบ 5% ของค่าจ้างที่ได้รับจริงในงวด ฐานคำนวณระหว่าง 1,650-17,500 บาท
// เพดาน 17,500 เป็นตัวเลขตามกฎหมายฉบับล่าสุด (ปรับขึ้นจาก 15,000 เดิม มีผลปลายปี 2568 — HR ยืนยันแล้ว
// 2026-08-20) ไม่ใช่นโยบายบริษัท ผลลัพธ์ปัดเป็นจำนวนเต็มบาทเสมอ ไม่ใช่ satang เหมือนบรรทัดอื่นบนสลิป
//
// ค่าคงที่เหล่านี้เป็นตัวเลขที่ประกาศโดยรัฐ ไม่ใช่ค่าที่ HR แก้ผ่านหน้า admin ได้ (ต่างจาก
// master_overtime_groups) — เก็บเป็น constant ในโค้ด ไม่สร้างตาราง master ใหม่ แม้จะมีแนวโน้มว่ารัฐจะ
// ปรับเพดานอีกในอนาคต (เพิ่งปรับมาแล้วครั้งหนึ่งปลายปี 2568) เพราะ (ก) ไม่มี precedent ของ effective-dated
// rate table ในระบบนี้เลย และ (ข) เมื่อถึงตอนนั้นค่อยแก้โค้ด+migration ใหม่ตามรอบที่รัฐประกาศจริง
// ดีกว่าสร้างโครงสร้าง versioned-rate ล่วงหน้าโดยเดาอนาคต

export const SOCIAL_SECURITY_RATE = 0.05
export const SOCIAL_SECURITY_WAGE_FLOOR = 1650
export const SOCIAL_SECURITY_WAGE_CEILING = 17500

/** ปัดเศษแบบ "round half up" เป็นจำนวนเต็ม — ต่างจาก round2() ใน payrollEarnings.ts ซึ่งปัดที่ 2
 *  ตำแหน่ง (สตางค์) ประกันสังคมต้องเป็นจำนวนเต็มบาทเท่านั้นตามที่ HR ยืนยัน (เศษ <0.50 ปัดลง, >=0.50 ปัดขึ้น)
 *  Math.round ของ JS ทำสิ่งนี้ตรงตัวสำหรับค่าบวกอยู่แล้ว (ปัดขึ้นที่ .5 พอดี) แยกฟังก์ชันออกมาต่างหากเพื่อ
 *  บอกเจตนาให้ชัด ไม่ปนกับ round2() ที่ปัดคนละตำแหน่ง — พิสูจน์กับตัวอย่างที่ HR ยืนยัน: 8.25 → 8, 500.45 → 500 */
export function roundHalfUpToBaht(value: number): number {
  return Math.round(value)
}

/** ค่าจ้างที่ต่ำกว่าหรือเท่ากับ 0 (พนักงานไม่มีวันได้ค่าจ้างเลยในงวดนี้ เช่น ลาไม่รับค่าจ้างทั้งงวด)
 *  คืน 0 โดยไม่ clamp ขึ้น floor — floor 1650 มีไว้กำหนดฐานขั้นต่ำของคนที่ "มีค่าจ้าง" ในงวดนั้นจริง
 *  ไม่ใช่กฎที่ตั้งใจให้เรียกเก็บจากคนที่ไม่มีรายได้เลย */
export function socialSecurityContribution(actualWageReceived: number): number {
  if (actualWageReceived <= 0) return 0
  const base = Math.min(Math.max(actualWageReceived, SOCIAL_SECURITY_WAGE_FLOOR), SOCIAL_SECURITY_WAGE_CEILING)
  return roundHalfUpToBaht(base * SOCIAL_SECURITY_RATE)
}
