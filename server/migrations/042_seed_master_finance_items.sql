-- Starter finance items, so the list isn't empty on a fresh install. Same
-- standing as the master_leave_types seed (015): a first draft for HR to
-- review and extend through the admin UI, not an authoritative list.
--
-- ค่าเอกสาร is income, not a deduction: in the system this replaces it is
-- what the company pays an employee for preparing documents, not a fee
-- recovered from wages. It was seeded the other way round at first and
-- corrected in 043 — see that file, which is what fixes databases this one
-- already ran against.
--
-- No 'tax' row is seeded: ภงด.1 withholding already comes from
-- employee_finance.tax_type, and the tax items that belong in this table are
-- the ad-hoc ones nobody can guess in advance.

INSERT INTO master_finance_items (item_code, item_name, item_type, description, sort_order)
VALUES
  ('SHIFT',        'ค่ากะ',      'income',    'เบี้ยเลี้ยงสำหรับการทำงานเป็นกะ',          10),
  ('TRAVEL',       'ค่าเดินทาง', 'income',    'ค่าเดินทางที่จ่ายให้พนักงานเป็นรายงวด',    20),
  ('DOCUMENT',     'ค่าเอกสาร',  'income',    'ค่าตอบแทนการจัดทำเอกสารที่บริษัทจ่ายให้พนักงาน', 30),
  ('STUDENT_LOAN', 'ค่า กยศ.',   'deduction', 'เงินกู้ยืมเพื่อการศึกษาที่หักนำส่ง กยศ.',  40);
