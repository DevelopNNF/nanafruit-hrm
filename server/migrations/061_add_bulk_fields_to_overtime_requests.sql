-- Supports "Bulk OT Request": a supervisor/HR/Admin filing the same OT
-- window for several employees at once from admin/.
--
-- batch_id ties together the several per-employee overtime_requests rows one
-- bulk submission created — NOT a foreign key to a batch table, because there
-- is no batch row: attendance_daily recompute, the weekly-cap check and
-- approval/rejection all operate one employee at a time already (see
-- overtimeRequests.ts), so each employee still gets their own real row with
-- its own day_status/shift snapshot (which can legitimately differ between
-- employees on the same calendar date). batch_id only lets the admin list/
-- detail UI show and act on the group as one unit. Generated in application
-- code (crypto.randomUUID()), not a DB default, since nothing about it needs
-- to survive a request that never reaches the insert. Null for every request
-- filed the normal way (an employee filing their own, one at a time) —
-- existing rows are untouched.
--
-- created_by_oid/created_by_name record who filed it when that is not the
-- employee themselves — null means "the employee filed this one", which
-- covers every row before this migration and every future self-service
-- request. Mirrors decided_by_oid/decided_by_name's existing shape.

ALTER TABLE overtime_requests
  ADD COLUMN batch_id uuid,
  ADD COLUMN created_by_oid text,
  ADD COLUMN created_by_name text;

CREATE INDEX overtime_requests_batch_id_idx
  ON overtime_requests (batch_id)
  WHERE batch_id IS NOT NULL;
