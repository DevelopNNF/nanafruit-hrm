-- Same optional supervisor-approval stage as 062/063/064/065, here for
-- time_correction_requests. See 062's comment for the full reasoning behind
-- each column and constraint — it applies unchanged here. This table has no
-- 'cancelled' status (see its own migration's comment — a time correction is
-- never withdrawn, only decided), so unlike the other four, there is no
-- cancel route to remember to clear current_stage in.

ALTER TABLE time_correction_requests
  ADD COLUMN requires_supervisor_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN supervisor_employee_id       bigint REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN current_stage                text CHECK (current_stage IN ('supervisor', 'hr')),
  ADD COLUMN supervisor_approved_by_oid   text,
  ADD COLUMN supervisor_approved_by_name  text,
  ADD COLUMN supervisor_approved_at       timestamptz;

UPDATE time_correction_requests SET current_stage = 'hr' WHERE status = 'pending';

ALTER TABLE time_correction_requests
  ADD CONSTRAINT time_correction_requests_stage_consistency CHECK (
    (status = 'pending') = (current_stage IS NOT NULL)
  ),
  ADD CONSTRAINT time_correction_requests_supervisor_requirement CHECK (
    requires_supervisor_approval = (supervisor_employee_id IS NOT NULL)
  ),
  ADD CONSTRAINT time_correction_requests_supervisor_stage_pending CHECK (
    current_stage IS DISTINCT FROM 'supervisor' OR supervisor_approved_by_oid IS NULL
  ),
  ADD CONSTRAINT time_correction_requests_supervisor_approval_consistency CHECK (
    (supervisor_approved_by_oid IS NULL AND supervisor_approved_by_name IS NULL AND supervisor_approved_at IS NULL) OR
    (supervisor_approved_by_oid IS NOT NULL AND supervisor_approved_by_name IS NOT NULL AND supervisor_approved_at IS NOT NULL)
  ),
  ADD CONSTRAINT time_correction_requests_supervisor_approval_requires_flag CHECK (
    supervisor_approved_by_oid IS NULL OR requires_supervisor_approval
  );

CREATE INDEX time_correction_requests_supervisor_pending_idx
  ON time_correction_requests (supervisor_employee_id, created_at DESC)
  WHERE current_stage = 'supervisor';
