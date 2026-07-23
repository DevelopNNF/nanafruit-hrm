-- Gender, split out from title: title (นาย/นาง/นางสาว) is a Thai honorific
-- that conflates marital status with gender, so it can't stand in for it —
-- master_leave_types.gender restricts a leave type to one sex (e.g. ลาคลอด
-- to female, ลาบวช to male), which needs a real answer to compare against.
--
-- Nullable, not backfilled: existing employees have never recorded this, and
-- there is no honest default to invent for them. HR fills it in per employee
-- through the employee form as needed; a leave type's gender restriction is
-- only ever enforced once this is set.

ALTER TABLE employees
  ADD COLUMN gender text CHECK (gender IN ('male', 'female'));
