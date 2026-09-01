-- Nationality (สัญชาติ). Nullable, not backfilled — same reasoning as 013's
-- gender column and 027's id_card_number: existing employees have never
-- recorded this, and there is no honest default to invent for them.
-- Required going forward is enforced in the API/UI, not here.
--
-- This is also what gates whether id_card_number is required: a foreign
-- national has no Thai ID card to give, and withholding tax (ภงด.3) only
-- needs one for a Thai national. See employees.ts's parseEmployeeBasicFields.

ALTER TABLE employees
  ADD COLUMN nationality text CHECK (nationality IN ('ไทย', 'ต่างชาติ'));
