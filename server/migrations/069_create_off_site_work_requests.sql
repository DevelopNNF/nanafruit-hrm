-- Off-site work requests (คำขอทำงานนอกสถานที่): an employee asks to work at
-- a place outside every master_locations geofence for a date range, naming
-- where and why. Same two-stage decision workflow as leave_requests
-- (ผู้ขอ → หัวหน้างาน → HR/Admin, always both stages — unlike leave_requests'
-- optional supervisor stage, HR confirmed this request type always needs
-- HR's own sign-off, so there is no requires_supervisor_approval flag here:
-- current_stage starts at 'supervisor' when the employee has one, 'hr'
-- otherwise, exactly like leave_requests, but the "does this need HR" case
-- doesn't apply).
--
-- Until approved, the employee's clock-in stays bound to master_locations
-- exactly as before — the geofence branch in POST /attendance/clock only
-- looks at rows here with status = 'approved'. Submitting a request creates
-- no exemption by itself, which is why the LIFF form warns the employee up
-- front that they cannot clock in off-site until HR (or a supervisor
-- override) actually approves it.
--
-- latitude/longitude/place_name are exactly what the employee submits, no
-- master-data row created — the location is one-off and scoped to this
-- request. There is deliberately no radius column: HR decided a single
-- system-wide default radius (OFF_SITE_DEFAULT_RADIUS_METERS in
-- shared/src/index.ts) applies to every approved request rather than letting
-- either the employee or HR set one per request.
--
-- No leave_balance_entry_id equivalent — this request type has no balance
-- ledger to post to, so decision_consistency only tracks the decided_by_*
-- columns, not a side-effect row.

CREATE TABLE off_site_work_requests (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id                 bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  place_name                  text NOT NULL,
  latitude                    numeric(9, 6) NOT NULL,
  longitude                   numeric(9, 6) NOT NULL,
  start_date                  date NOT NULL,
  end_date                    date NOT NULL,
  reason                      text NOT NULL,
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  supervisor_employee_id      bigint REFERENCES employees(id) ON DELETE SET NULL,
  current_stage               text CHECK (current_stage IN ('supervisor', 'hr')),
  supervisor_approved_by_oid  text,
  supervisor_approved_by_name text,
  supervisor_approved_at      timestamptz,
  decided_by_oid              text,
  decided_by_name             text,
  decided_at                  timestamptz,
  decision_reason             text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT off_site_work_requests_date_range CHECK (end_date >= start_date),
  -- pending has a stage; nothing else does — same shape as
  -- leave_requests_stage_consistency.
  CONSTRAINT off_site_work_requests_stage_consistency CHECK (
    (status = 'pending') = (current_stage IS NOT NULL)
  ),
  -- Still waiting on the supervisor means they haven't forwarded it yet.
  CONSTRAINT off_site_work_requests_supervisor_stage_pending CHECK (
    current_stage IS DISTINCT FROM 'supervisor' OR supervisor_approved_by_oid IS NULL
  ),
  -- The three supervisor_approved_by_* columns are all-or-nothing.
  CONSTRAINT off_site_work_requests_supervisor_approval_consistency CHECK (
    (supervisor_approved_by_oid IS NULL AND supervisor_approved_by_name IS NULL AND supervisor_approved_at IS NULL) OR
    (supervisor_approved_by_oid IS NOT NULL AND supervisor_approved_by_name IS NOT NULL AND supervisor_approved_at IS NOT NULL)
  ),
  CONSTRAINT off_site_work_requests_decision_consistency CHECK (
    (status IN ('pending', 'cancelled') AND decided_by_oid IS NULL     AND decided_at IS NULL     AND decision_reason IS NULL) OR
    (status = 'approved'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NULL) OR
    (status = 'rejected'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
  )
);

-- An employee's own request history, most recent first.
CREATE INDEX off_site_work_requests_employee_idx
  ON off_site_work_requests (employee_id, created_at DESC);

-- Admin's review queue, filtered by status, most recent first.
CREATE INDEX off_site_work_requests_status_idx
  ON off_site_work_requests (status, created_at DESC);

-- The supervisor's own inbox — same partial shape as
-- leave_requests_supervisor_pending_idx.
CREATE INDEX off_site_work_requests_supervisor_pending_idx
  ON off_site_work_requests (supervisor_employee_id, created_at DESC)
  WHERE current_stage = 'supervisor';

-- The geofence branch in POST /attendance/clock looks up, per employee per
-- day, whether an approved request covers today — same access pattern
-- loadLeaveByDate/loadOvertimeByDate already use against leave_requests/
-- overtime_requests, so this is indexed the same way: the (employee_id,
-- status) prefix does the filtering, start_date/end_date are range-scanned.
CREATE INDEX off_site_work_requests_employee_status_dates_idx
  ON off_site_work_requests (employee_id, status, start_date, end_date);
