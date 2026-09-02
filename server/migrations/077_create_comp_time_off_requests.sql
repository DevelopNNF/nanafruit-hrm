-- Comp-time-off requests (ขอใช้วันหยุดสะสม): the employee-initiated request to
-- spend accrued comp-time-off balance (see overtime_comp_time_entries, added
-- in the next migration). Deliberately a separate, simpler table from
-- leave_requests rather than a new master_leave_types row — the balance here
-- is tracked in minutes (matching how OT accrues it), not days, and none of
-- leave_requests' per-leave-type eligibility rules (gender, advance notice,
-- half-day/hourly flags) apply to it.
--
-- Same four-state pending/approved/rejected/cancelled decision workflow and
-- decision_consistency shape as leave_requests/overtime_requests (022, 039),
-- combined from the start with the two-stage supervisor->HR approval that
-- those two tables only grew later (062, 063) — see either migration's
-- comment for the full reasoning, unchanged here: requires_supervisor_approval
-- and supervisor_employee_id are resolved once at submission from the
-- employee's reporting line, current_stage tracks which stage a pending
-- request is waiting on, and a supervisor decision is recorded separately
-- from the final HR/Admin decision (decided_by_oid/decided_at/decision_reason)
-- so both hand-offs are visible in one row.
--
-- off_date/start_time/end_time mirror overtime_requests' shape: a whole-day
-- request has both times null, a partial-day request (spending an exact
-- number of hours) has both set. requested_minutes is what actually gets
-- checked against and deducted from the balance — the time-of-day fields are
-- for HR's/the employee's own reference, not something balance math reads.

CREATE TABLE comp_time_off_requests (
  id                            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id                   bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  off_date                      date NOT NULL,
  start_time                    time,
  end_time                      time,
  requested_minutes             integer NOT NULL CHECK (requested_minutes > 0),
  reason                        text NOT NULL,
  status                        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requires_supervisor_approval  boolean NOT NULL DEFAULT false,
  supervisor_employee_id        bigint REFERENCES employees(id) ON DELETE SET NULL,
  current_stage                 text CHECK (current_stage IN ('supervisor', 'hr')),
  supervisor_approved_by_oid    text,
  supervisor_approved_by_name   text,
  supervisor_approved_at        timestamptz,
  decided_by_oid                text,
  decided_by_name               text,
  decided_at                    timestamptz,
  decision_reason               text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comp_time_off_requests_time_pair CHECK ((start_time IS NULL) = (end_time IS NULL)),
  CONSTRAINT comp_time_off_requests_decision_consistency CHECK (
    (status IN ('pending', 'cancelled') AND decided_by_oid IS NULL     AND decided_at IS NULL     AND decision_reason IS NULL) OR
    (status = 'approved'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NULL) OR
    (status = 'rejected'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
  ),
  CONSTRAINT comp_time_off_requests_stage_consistency CHECK (
    (status = 'pending') = (current_stage IS NOT NULL)
  ),
  CONSTRAINT comp_time_off_requests_supervisor_requirement CHECK (
    requires_supervisor_approval = (supervisor_employee_id IS NOT NULL)
  ),
  CONSTRAINT comp_time_off_requests_supervisor_stage_pending CHECK (
    current_stage IS DISTINCT FROM 'supervisor' OR supervisor_approved_by_oid IS NULL
  ),
  CONSTRAINT comp_time_off_requests_supervisor_approval_consistency CHECK (
    (supervisor_approved_by_oid IS NULL AND supervisor_approved_by_name IS NULL AND supervisor_approved_at IS NULL) OR
    (supervisor_approved_by_oid IS NOT NULL AND supervisor_approved_by_name IS NOT NULL AND supervisor_approved_at IS NOT NULL)
  ),
  CONSTRAINT comp_time_off_requests_supervisor_approval_requires_flag CHECK (
    supervisor_approved_by_oid IS NULL OR requires_supervisor_approval
  )
);

-- An employee's own request history, most recent first.
CREATE INDEX comp_time_off_requests_employee_idx
  ON comp_time_off_requests (employee_id, created_at DESC);

-- Admin's review queue, filtered by status, most recent first.
CREATE INDEX comp_time_off_requests_status_idx
  ON comp_time_off_requests (status, created_at DESC);

-- The supervisor's own inbox — same shape as leave_requests/overtime_requests'
-- identical index.
CREATE INDEX comp_time_off_requests_supervisor_pending_idx
  ON comp_time_off_requests (supervisor_employee_id, created_at DESC)
  WHERE current_stage = 'supervisor';
