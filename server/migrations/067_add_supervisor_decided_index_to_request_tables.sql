-- The LIFF approval inbox's "ตัดสินใจแล้ว" (done) tab queries each request
-- table for rows a specific supervisor already decided
-- (supervisor_employee_id = $1 AND status <> 'pending'), the mirror image of
-- the existing <table>_supervisor_pending_idx added by migrations 062-066
-- for the "pending" tab. That index only covers current_stage = 'supervisor'
-- rows, so a decided-rows lookup would otherwise be a sequential scan.

CREATE INDEX leave_requests_supervisor_decided_idx
  ON leave_requests (supervisor_employee_id, decided_at DESC)
  WHERE supervisor_employee_id IS NOT NULL AND status <> 'pending';

CREATE INDEX overtime_requests_supervisor_decided_idx
  ON overtime_requests (supervisor_employee_id, decided_at DESC)
  WHERE supervisor_employee_id IS NOT NULL AND status <> 'pending';

CREATE INDEX shift_change_requests_supervisor_decided_idx
  ON shift_change_requests (supervisor_employee_id, decided_at DESC)
  WHERE supervisor_employee_id IS NOT NULL AND status <> 'pending';

CREATE INDEX day_off_swap_requests_supervisor_decided_idx
  ON day_off_swap_requests (supervisor_employee_id, decided_at DESC)
  WHERE supervisor_employee_id IS NOT NULL AND status <> 'pending';

CREATE INDEX time_correction_requests_supervisor_decided_idx
  ON time_correction_requests (supervisor_employee_id, decided_at DESC)
  WHERE supervisor_employee_id IS NOT NULL AND status <> 'pending';
