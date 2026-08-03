-- National ID card number (เลขบัตรประชาชน). Nullable at the DB: existing
-- employees have never recorded this, and there is no honest default to
-- backfill — same reasoning as 013's gender column. Required going forward
-- is enforced in the API/UI, not here. Format-checked (13 digits) but the
-- checksum digit is validated in application code, not reproducible as a
-- portable CHECK expression.
--
-- Unique because it's a real-world identifier: two employees can't
-- legitimately share one national ID. Multiple NULLs are allowed — Postgres
-- treats NULL as distinct from itself in a UNIQUE constraint.

ALTER TABLE employees
  ADD COLUMN id_card_number text CHECK (id_card_number ~ '^[0-9]{13}$'),
  ADD CONSTRAINT employees_id_card_number_key UNIQUE (id_card_number);
