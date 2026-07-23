-- Default leave types, so the list isn't empty on a fresh install. Rough
-- defaults from Thai labor-law practice — HR is expected to review and
-- adjust each row (advance notice, paid/unpaid, min/max) to match actual
-- company policy through the admin UI; nothing here is authoritative.

INSERT INTO master_leave_types
  (leave_code, leave_name, is_paid, allow_half_day, allow_hourly,
   min_leave_days, max_leave_days, advance_notice_days, gender,
   is_count_holiday, is_count_weekend, sort_order)
VALUES
  ('SICK',       'ลาป่วย',         true,  true,  false, 0.5, NULL, 0,  'all',    false, false, 10),
  ('PERSONAL',   'ลากิจธุระ',      true,  true,  false, 0.5, NULL, 1,  'all',    false, false, 20),
  ('ANNUAL',     'ลาพักร้อน',      true,  true,  false, 0.5, NULL, 3,  'all',    false, false, 30),
  ('MATERNITY',  'ลาคลอดบุตร',     true,  false, false, 1,   98,   0,  'female', false, false, 40),
  ('ORDINATION', 'ลาบวช',          false, false, false, 1,   NULL, 15, 'male',   false, false, 50),
  ('UNPAID',     'ลาไม่รับค่าจ้าง', false, true,  false, 0.5, NULL, 1,  'all',    false, false, 60);
