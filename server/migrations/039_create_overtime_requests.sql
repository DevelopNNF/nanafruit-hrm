-- Overtime requests (ขอทำงานล่วงเวลา): the employee-initiated request for a
-- block of time on one date to be paid as OT. Same four-state
-- pending/approved/rejected/cancelled decision workflow as
-- day_off_swap_requests, editable by the employee (PUT) while pending, and —
-- like it — approval writes into no other ledger: an approved row here IS the
-- record, and the (not-yet-built) OT calculation reads master_overtime_groups
-- against it.
--
-- ot_date anchors the request to the day the OT STARTS, the same convention
-- attendance_daily.work_date uses: a 22:00-01:00 request is ot_date = the day
-- it began, and end_time <= start_time is what says it runs into the next
-- calendar day. Same rule master_shifts states for shift_end_time, and it
-- lives in application code there too (see computeOvertimeMinutes in
-- shared/src/index.ts), not in a CHECK here.
--
-- requested_minutes is stored rather than derived on read for two reasons: it
-- is what the OT calculation will multiply a rate by, and deriving it would
-- mean re-deciding the midnight-crossing question at every read site. Minutes,
-- not fractional hours, matching attendance_daily's worked_minutes/
-- late_minutes — the whole schema counts time in whole minutes.
--
-- day_status, day_label, the shift_* columns and overtime_group_id are
-- SNAPSHOTS taken when the request was submitted, deliberately not joins:
-- employment_details keeps no history of which OT group an employee belonged
-- to, and employee_shift_assignments can be rewritten by a later approved
-- shift change. Without these, approving a request in April could quietly
-- reprice work done in March. day_status carries the same six CalendarDayStatus
-- values attendance_daily.day_status does, for the same reason: which of
-- master_overtime_groups' five rates applies depends on how the day was
-- classified, and re-deriving that months later is not guaranteed to give the
-- answer that was true at the time.
--
-- overtime_group_id is NOT NULL: an OT request that cannot be priced is not a
-- request, it is a data-entry problem, so the route refuses to create one for
-- an employee HR has not assigned a group to yet.
--
-- There is deliberately NO unique constraint on (employee_id, ot_date), unlike
-- shift_change_requests' one-live-request-per-date rule. A single day really
-- does carry more than one OT block — an hour before the shift and two after
-- it are two separate requests — so what must not collide is an overlapping
-- TIME RANGE, which is checked in application code (hasOverlappingOvertimeRequest)
-- because the ranges being compared can be anchored to different ot_dates.

CREATE TABLE overtime_requests (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id        bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  ot_date            date NOT NULL,
  start_time         time NOT NULL,
  end_time           time NOT NULL,
  requested_minutes  integer NOT NULL CHECK (requested_minutes > 0 AND requested_minutes <= 720),
  day_status         text NOT NULL CHECK (day_status IN (
                       'workday', 'weekly_off', 'holiday', 'leave',
                       'swap_workday', 'swap_dayoff'
                     )),
  day_label          text,
  shift_id           bigint REFERENCES master_shifts(id) ON DELETE RESTRICT,
  shift_start_time   time,
  shift_end_time     time,
  overtime_group_id  bigint NOT NULL REFERENCES master_overtime_groups(id) ON DELETE RESTRICT,
  reason             text NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by_oid     text,
  decided_by_name    text,
  decided_at         timestamptz,
  decision_reason    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- The shift snapshot is all three columns or none of them, the same way
  -- attendance_daily pairs its expected_check_in_at/expected_check_out_at:
  -- a half-recorded window is worse than a recorded absence of one.
  CONSTRAINT overtime_requests_shift_snapshot CHECK (
    (shift_id IS NULL) = (shift_start_time IS NULL)
    AND (shift_start_time IS NULL) = (shift_end_time IS NULL)
  ),
  -- The same four-state pattern as leave_requests/shift_change_requests:
  -- pending and cancelled share the "nothing decided yet" shape.
  CONSTRAINT overtime_requests_decision_consistency CHECK (
    (status IN ('pending', 'cancelled') AND decided_by_oid IS NULL     AND decided_at IS NULL     AND decision_reason IS NULL) OR
    (status = 'approved'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NULL) OR
    (status = 'rejected'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
  )
);

-- An employee's own request history, most recent first.
CREATE INDEX overtime_requests_employee_idx
  ON overtime_requests (employee_id, created_at DESC);

-- Admin's review queue, filtered by status, most recent first.
CREATE INDEX overtime_requests_status_idx
  ON overtime_requests (status, created_at DESC);

-- The overlap check, which reads one employee's requests over a three-day
-- window around the date being submitted (an overnight request can start the
-- day before the one it collides with).
CREATE INDEX overtime_requests_employee_date_idx
  ON overtime_requests (employee_id, ot_date);
