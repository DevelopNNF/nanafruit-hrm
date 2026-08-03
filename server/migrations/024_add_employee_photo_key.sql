-- The R2 object key of the employee's current profile photo, not a URL —
-- photos live in a private bucket, so every read goes through a presigned
-- GET minted on request (see storage/employeePhotos.ts). Null means no photo
-- uploaded yet. One photo per employee, no history: unlike shift changes
-- (employee_shift_assignments), a replaced photo has no value once it's gone,
-- so there's nothing here worth a ledger table.

ALTER TABLE employees ADD COLUMN photo_key text;
