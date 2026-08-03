-- ชื่อ-นามสกุล (EN) is no longer required for every employee — HR may not
-- have the English name on file yet for some records. first_name_th/
-- last_name_th stay required; only the EN columns are relaxed.

ALTER TABLE employees
  ALTER COLUMN first_name_en DROP NOT NULL,
  ALTER COLUMN last_name_en DROP NOT NULL;
