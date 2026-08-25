-- Same optional supervisor-approval stage as 062 added to leave_requests,
-- here for overtime_requests: ผู้ขอ → หัวหน้างาน → HR/Admin when there is one,
-- ผู้ขอ → HR/Admin directly when there isn't. See 062's comment for the full
-- reasoning behind each column and constraint — it applies unchanged here.
--
-- One addition specific to this table: a "Bulk OT Request" row (batch_id NOT
-- NULL, see migration 061) is filed BY a supervisor/HR/Admin ON BEHALF OF
-- several employees, not by the employee themselves. Routing it to each
-- employee's own supervisor would usually mean routing it to the very person
-- who just filed it — a self-approval loop. Confirmed instead: a bulk
-- request's supervisor_employee_id is the FILER's own supervisor (their
-- supervisor's supervisor, from the employee's point of view), resolved once
-- per batch and applied to every row in it, not resolved per employee the
-- way a self-filed request is. That resolution happens in application code
-- (routes/overtimeRequests.ts); nothing about that distinction needs to be
-- expressed here at the schema level — a bulk row's supervisor_employee_id
-- is still just "whoever must act next", same as any other row's.

ALTER TABLE overtime_requests
  ADD COLUMN requires_supervisor_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN supervisor_employee_id       bigint REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN current_stage                text CHECK (current_stage IN ('supervisor', 'hr')),
  ADD COLUMN supervisor_approved_by_oid   text,
  ADD COLUMN supervisor_approved_by_name  text,
  ADD COLUMN supervisor_approved_at       timestamptz;

-- Backfill: every request already sitting pending before this migration had
-- no supervisor stage, so it goes straight to 'hr' — the same place a
-- no-supervisor request lands under the new rule.
UPDATE overtime_requests SET current_stage = 'hr' WHERE status = 'pending';

ALTER TABLE overtime_requests
  ADD CONSTRAINT overtime_requests_stage_consistency CHECK (
    (status = 'pending') = (current_stage IS NOT NULL)
  ),
  ADD CONSTRAINT overtime_requests_supervisor_requirement CHECK (
    requires_supervisor_approval = (supervisor_employee_id IS NOT NULL)
  ),
  ADD CONSTRAINT overtime_requests_supervisor_stage_pending CHECK (
    current_stage IS DISTINCT FROM 'supervisor' OR supervisor_approved_by_oid IS NULL
  ),
  ADD CONSTRAINT overtime_requests_supervisor_approval_consistency CHECK (
    (supervisor_approved_by_oid IS NULL AND supervisor_approved_by_name IS NULL AND supervisor_approved_at IS NULL) OR
    (supervisor_approved_by_oid IS NOT NULL AND supervisor_approved_by_name IS NOT NULL AND supervisor_approved_at IS NOT NULL)
  ),
  ADD CONSTRAINT overtime_requests_supervisor_approval_requires_flag CHECK (
    supervisor_approved_by_oid IS NULL OR requires_supervisor_approval
  );

-- The supervisor's own inbox — see 062's identical index for leave_requests.
CREATE INDEX overtime_requests_supervisor_pending_idx
  ON overtime_requests (supervisor_employee_id, created_at DESC)
  WHERE current_stage = 'supervisor';
