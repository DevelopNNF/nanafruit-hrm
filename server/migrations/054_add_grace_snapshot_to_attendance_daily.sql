-- Snapshotting the grace minutes a day's late/early verdict was judged
-- against, alongside the late_minutes/early_leave_minutes 037 already stores.
--
-- master_shifts.late_grace_minutes/early_leave_grace_minutes (036) decide
-- only WHETHER a punch counts as late, not how late attendance_daily records
-- it as — see computeAttendanceDay's comment. Payroll needs the excess over
-- grace, not the full amount, to price a late deduction: max(0, late_minutes
-- - late_grace_minutes). Reading master_shifts fresh at payroll-calculation
-- time would let HR editing a shift's grace today silently change the
-- deduction on an already-closed period's late minutes — the same trap
-- 046_create_employee_wage_assignments.sql closed for wages. So the grace in
-- force at compute time is frozen here, next to the minutes it decided.

ALTER TABLE attendance_daily
  ADD COLUMN late_grace_minutes        smallint NOT NULL DEFAULT 0,
  ADD COLUMN early_leave_grace_minutes smallint NOT NULL DEFAULT 0;

ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_grace_minutes_range
  CHECK (late_grace_minutes >= 0 AND early_leave_grace_minutes >= 0);
