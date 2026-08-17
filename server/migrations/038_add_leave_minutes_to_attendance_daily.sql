-- Partial-day leave: what a day actually owed, once approved leave is carved
-- out of the shift window.
--
-- 037 assumed a day was either fully worked or fully off, because
-- CalendarDayStatus collapses any leave — half day, one hour, or the whole
-- day — into a single 'leave' on the entire date. A half-day leave therefore
-- came out as attendance_status = 'unscheduled_work' with worked_minutes
-- NULL: the hours the employee really did work were dropped, and leaving
-- early on top of it was invisible.
--
-- The fix keeps day_status single-valued (it is still useful for reports, and
-- making it multi-valued would explode combinatorially) and moves the
-- multi-event reality into quantities instead:
--
--   expected_work_minutes  what the day owed, net of unpaid break AND leave
--   leave_minutes          working minutes excused by approved leave
--   effective_check_in_at  when the employee was really due in ...
--   effective_check_out_at ... and really due out
--
-- On an ordinary day the effective_* pair equals the expected_* pair. On a
-- morning-leave day the effective check-in is the leave's end, so arriving
-- then is on time rather than hours late. An hour of leave in the middle of a
-- shift moves neither bound and only reduces expected_work_minutes — see
-- expectedWorkIntervals in attendanceMatchingQueries.ts, which is the list
-- these two columns are the outer edges of.
--
-- Work is "expected" wherever expected_work_minutes > 0, which is why no new
-- attendance_status value is needed: a half-day leave that was worked is just
-- 'present' against a smaller expectation.
--
-- Backfill sets expected_work_minutes to NULL rather than guessing: rows
-- written by 037 never had the concept, and the batch job recomputes a
-- rolling window anyway (see computeAttendanceDaily.ts), so every row still
-- in scope corrects itself on the next run.

ALTER TABLE attendance_daily
  ADD COLUMN expected_work_minutes  integer,
  ADD COLUMN leave_minutes          integer NOT NULL DEFAULT 0,
  ADD COLUMN effective_check_in_at  timestamptz,
  ADD COLUMN effective_check_out_at timestamptz;

ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_leave_minutes_range
  CHECK (
    leave_minutes >= 0
    AND (expected_work_minutes IS NULL OR expected_work_minutes >= 0)
  );

-- Same pairing rule as the expected_* columns: both edges of the effective
-- window are present, or neither is (nothing was owed that day).
ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_effective_pair
  CHECK ((effective_check_in_at IS NULL) = (effective_check_out_at IS NULL));
