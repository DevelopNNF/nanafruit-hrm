-- Overtime, resolved against what was actually punched.
--
-- 037 said the quiet part out loud: worked_minutes is clamped to the shift
-- window "and time worked outside the window is overtime and is priced
-- separately by master_overtime_groups, so it is deliberately not added in
-- here." These four columns are that separate accounting, and they live on
-- attendance_daily rather than in a table of their own for the reason the
-- rest of this table exists: the batch job already writes one row per
-- employee per date and already recomputes a rolling window idempotently, so
-- an OT request approved after the fact corrects itself on the next run with
-- no invalidation queue to maintain.
--
-- Like every other column here this is DERIVED. Editing it by hand does not
-- change what anyone is paid; it changes back on the next run. To change the
-- numbers, change the approved overtime_requests row or the punches.
--
-- Why four columns rather than one "OT minutes":
--
--   approved_ot_minutes  what was asked for and granted, raw
--   actual_ot_minutes    how much of that the employee was actually present
--                        for, raw — the intersection of the approved blocks
--                        with [actual_check_in_at, actual_check_out_at]
--   ot_normal_minutes    "ในเวลา" after the group's rounding rule
--   ot_extra_minutes     "นอกเวลา" after the group's rounding rule
--
-- Pay follows the last two. The first two exist so the question HR will
-- actually ask — "he requested two hours, why is he being paid one?" — has an
-- answer in the row itself rather than requiring someone to re-derive it from
-- raw punches months later.
--
-- Which of master_overtime_groups' five rates each bucket maps to is decided
-- by day_status, already on this row, so no sixth column is needed:
--
--   workday / swap_workday   extra -> rate_ot_workday      (normal is always 0)
--   weekly_off / swap_dayoff normal -> rate_normal_dayoff,  extra -> rate_ot_dayoff
--   holiday                  normal -> rate_normal_holiday, extra -> rate_ot_holiday
--
-- The "normal is always 0 on a workday" case is not a convention, it is
-- enforced upstream: POST /overtime-requests refuses a range that overlaps
-- the shift, so on a workday every approved OT minute is by construction
-- outside normal hours. The CHECK below holds that guarantee at the storage
-- layer, where it will still be true if the route's rule is ever relaxed by
-- someone who has not read it.
--
-- Existing rows default to 0 rather than NULL: zero overtime is the truth for
-- every date before this feature existed, not an unknown.

ALTER TABLE attendance_daily
  ADD COLUMN approved_ot_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN actual_ot_minutes   integer NOT NULL DEFAULT 0,
  ADD COLUMN ot_normal_minutes   integer NOT NULL DEFAULT 0,
  ADD COLUMN ot_extra_minutes    integer NOT NULL DEFAULT 0;

ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_ot_minutes_range
  CHECK (
    approved_ot_minutes >= 0 AND actual_ot_minutes >= 0
    AND ot_normal_minutes >= 0 AND ot_extra_minutes >= 0
    -- Nobody can be present for more overtime than was approved.
    AND actual_ot_minutes <= approved_ot_minutes
  );

-- On a normal working day there is no such thing as an "in hours" overtime
-- minute — see above.
ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_ot_workday_has_no_normal
  CHECK (
    day_status NOT IN ('workday', 'swap_workday') OR ot_normal_minutes = 0
  );

-- The OT report sums over a date range across every employee, and the vast
-- majority of rows have no overtime at all — a partial index keeps that scan
-- proportional to the days that actually carry some.
--
-- Predicated on approved_ot_minutes because that is the widest of the four:
-- the CHECK above makes actual <= approved, and the two buckets are cut from
-- actual, so a row with no approved overtime has none of any kind. It also
-- keeps the rows the report most needs to show — approved but not worked.
CREATE INDEX attendance_daily_overtime_idx
  ON attendance_daily (work_date, employee_id)
  WHERE approved_ot_minutes > 0;
