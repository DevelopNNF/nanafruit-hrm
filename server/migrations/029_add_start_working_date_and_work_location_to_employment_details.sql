-- start_working_date (วันที่เริ่มงาน): a date distinct from hire_date
-- (วันที่จ้าง) — HR tracks the two independently (e.g. a contract signed on
-- one date, work actually starting on another).
--
-- work_location (สถานที่ปฏิบัติงาน): text + CHECK rather than a master table,
-- same reasoning as title/employment_type — a fixed, rarely-changing pair of
-- office locations, not something HR manages via CRUD.
--
-- Both nullable: existing employees have never recorded either, same
-- reasoning as 013's gender / 027's id_card_number. Required going forward
-- is enforced in the API/UI.

ALTER TABLE employment_details
  ADD COLUMN start_working_date date,
  ADD COLUMN work_location text CHECK (work_location IN ('เชียงใหม่', 'ลำพูน'));
