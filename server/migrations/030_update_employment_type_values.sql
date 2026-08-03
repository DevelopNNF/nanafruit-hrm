-- Replaces the employment_type value set entirely: Permanent/Contract/Daily/
-- Regularly become ประจำ(รายเดือน)/ประจำ(รายวัน)/สัญญาจ้าง/ชั่วคราว. Existing
-- rows are remapped 1:1 before the CHECK is swapped, so no row is ever left
-- holding a value outside the new constraint's list.
--
--   Permanent -> ประจำ (รายเดือน)
--   Daily     -> ประจำ (รายวัน)
--   Contract  -> สัญญาจ้าง
--   Regularly -> ชั่วคราว   (part-time / non-regular work, despite the old name)

-- The old CHECK must go first: it would otherwise reject the very rows the
-- UPDATEs below are trying to remap into it.
ALTER TABLE employment_details DROP CONSTRAINT employment_details_employment_type_check;

UPDATE employment_details SET employment_type = 'ประจำ (รายเดือน)' WHERE employment_type = 'Permanent';
UPDATE employment_details SET employment_type = 'ประจำ (รายวัน)' WHERE employment_type = 'Daily';
UPDATE employment_details SET employment_type = 'สัญญาจ้าง' WHERE employment_type = 'Contract';
UPDATE employment_details SET employment_type = 'ชั่วคราว' WHERE employment_type = 'Regularly';

ALTER TABLE employment_details
  ADD CONSTRAINT employment_details_employment_type_check CHECK (
    employment_type IN ('ประจำ (รายเดือน)', 'ประจำ (รายวัน)', 'สัญญาจ้าง', 'ชั่วคราว')
  );
