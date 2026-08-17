-- One row per employee per work-date: the daily attendance verdict computed
-- from attendance_events, written by the attendance:compute batch job (see
-- server/src/computeAttendanceDaily.ts).
--
-- IMPORTANT: this table is DERIVED DATA, not a source of truth. Every column
-- is recomputable from attendance_events plus the assignment/holiday/leave/
-- swap ledgers, and the job recomputes a rolling window on every run — so a
-- hand-edited row here is not authoritative and will be silently overwritten
-- the next time the job covers that date. To change a verdict, change what it
-- derives from (a time correction, a shift change, an approved leave).
--
-- work_date anchors an overnight shift to the day it STARTED: a 22:00-07:00
-- shift beginning the evening of the 14th is work_date = the 14th, and its
-- expected_check_out_at lands on the 15th. Same convention master_shifts'
-- comment gives shift_end_time < shift_start_time.
--
-- day_status snapshots how the calendar classified the date (the six
-- CalendarDayStatus values in shared/src/index.ts); attendance_status is the
-- verdict itself (ATTENDANCE_DAY_STATUSES in server/src/attendanceDailyQueries.ts).
-- Both are stored rather than re-derived so a report can filter on "absent on
-- a scheduled workday" vs "worked on a holiday" without recomputing anything.
--
-- late_minutes/early_leave_minutes are the full amount past the shift's own
-- start/end, not the excess over the grace period — grace decides only
-- WHETHER they count. worked_minutes is clamped to the shift window and net
-- of the scheduled break; time worked outside the window is overtime and is
-- priced separately by master_overtime_groups, so it is deliberately not
-- added in here. The raw span stays recoverable from the actual_* timestamps.
--
-- ON DELETE RESTRICT on shift_id matches attendance_events and
-- employee_shift_assignments: there is no DELETE route for master_shifts.
-- The event FKs are SET NULL rather than RESTRICT — attendance_events has no
-- delete route either, but a derived pointer must never be the thing that
-- blocks cleaning up a source row.

CREATE TABLE attendance_daily (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id               bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date                 date NOT NULL,
  shift_id                  bigint REFERENCES master_shifts(id) ON DELETE RESTRICT,
  day_status                text NOT NULL CHECK (day_status IN (
                              'workday', 'weekly_off', 'holiday', 'leave',
                              'swap_workday', 'swap_dayoff'
                            )),
  attendance_status         text NOT NULL CHECK (attendance_status IN (
                              'present', 'incomplete', 'absent', 'day_off', 'unscheduled_work'
                            )),
  expected_check_in_at      timestamptz,
  expected_check_out_at     timestamptz,
  actual_check_in_at        timestamptz,
  actual_check_out_at       timestamptz,
  actual_check_in_event_id  bigint REFERENCES attendance_events(id) ON DELETE SET NULL,
  actual_check_out_event_id bigint REFERENCES attendance_events(id) ON DELETE SET NULL,
  late_minutes              integer NOT NULL DEFAULT 0,
  early_leave_minutes       integer NOT NULL DEFAULT 0,
  worked_minutes            integer,
  is_overnight              boolean NOT NULL DEFAULT false,
  computed_at               timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_daily_minutes_range CHECK (
    late_minutes >= 0 AND early_leave_minutes >= 0
    AND (worked_minutes IS NULL OR worked_minutes >= 0)
  ),
  -- Expected times are both set or both absent, same as the window they come
  -- from: ExpectedShiftWindow nulls them exactly when no shift applied.
  CONSTRAINT attendance_daily_expected_pair CHECK (
    (expected_check_in_at IS NULL) = (expected_check_out_at IS NULL)
  )
);

-- The upsert key. Load-bearing: it is what makes the batch job idempotent,
-- so re-running it over a range converges instead of duplicating.
CREATE UNIQUE INDEX attendance_daily_employee_work_date_key
  ON attendance_daily (employee_id, work_date);

-- "Who was late / absent yesterday", across every employee.
CREATE INDEX attendance_daily_work_date_idx ON attendance_daily (work_date DESC);
