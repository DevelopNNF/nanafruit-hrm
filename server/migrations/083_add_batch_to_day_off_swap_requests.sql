-- Supports "ขอสลับวันหยุดแบบกลุ่ม": a supervisor/HR/Admin filing the same
-- work_date/off_date swap for several employees at once from admin/.
--
-- batch_id ties together the several per-employee day_off_swap_requests rows
-- one bulk submission created — NOT a foreign key to a batch table, because
-- there is no batch row: approval already operates one employee at a time
-- (buildCalendarDaysForDates classification, shift lookup, and conflict
-- checks all differ per employee even for the same pair of dates — see
-- dayOffSwapRequestQueries.ts), so each employee still gets their own real
-- row with its own work_date_original_status/label snapshot. batch_id only
-- lets the admin list/detail UI show and act on the group as one unit.
-- Generated in application code (crypto.randomUUID()), not a DB default,
-- since nothing about it needs to survive a request that never reaches the
-- insert. Null for every request filed the normal way (an employee filing
-- their own, one at a time, or an admin filing for exactly one employee
-- through the same bulk endpoint) — existing rows are untouched. Mirrors
-- overtime_requests.batch_id and its reasoning (migration 061).
--
-- created_by_oid/created_by_name record who filed it when that is not the
-- employee themselves — null means "the employee filed this one" (LIFF
-- self-service), which covers every row before this migration and every
-- future self-service request. Mirrors overtime_requests' columns of the
-- same name.

ALTER TABLE day_off_swap_requests
  ADD COLUMN batch_id uuid,
  ADD COLUMN created_by_oid text,
  ADD COLUMN created_by_name text;

CREATE INDEX day_off_swap_requests_batch_id_idx
  ON day_off_swap_requests (batch_id)
  WHERE batch_id IS NOT NULL;
