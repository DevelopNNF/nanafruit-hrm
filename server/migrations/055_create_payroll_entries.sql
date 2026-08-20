-- One row per employee per payroll period: the frozen result of "calculate"
-- for that person. Phase 2 only ever fills the basic-wage columns — OT
-- (Phase 3), statutory deductions (Phase 4/5) and tax (Phase 5/6) all add
-- their own summary columns to this row in later migrations, the same
-- incremental way 038 added leave_minutes onto attendance_daily rather than
-- redesigning it.
--
-- Everything here is a snapshot, not something re-derived on read — see
-- Principle 01 in the payroll plan. employee_code/employee_name are copied
-- rather than joined so that HR correcting a typo in an employee's name next
-- year does not silently rewrite a payslip already filed with the Revenue
-- Department. wage_type is copied for the same reason: which formula ran is
-- itself part of the record.
--
-- employee_id is ON DELETE RESTRICT rather than the CASCADE most tables in
-- this schema use (attendance_daily, employee_wage_assignments,
-- employee_finance_items): a payslip has to survive 5 years by law, and must
-- never be able to vanish because an employee row did. There is no DELETE
-- route for employees today, so this is currently unreachable in practice —
-- RESTRICT documents the intent rather than guards against a real path.
--
-- payroll_period_id is also RESTRICT: a period with entries against it is not
-- something payroll_periods' own routes can delete anyway (there is no DELETE
-- route there either, only void), but the same reasoning applies.
--
-- Recalculating a period while it is still draft/calculating deletes and
-- reinserts every entry for that period (see calculatePayrollEntries in
-- payrollEntryQueries.ts) rather than updating in place, the same
-- delete-and-reinsert idempotency recomputeAttendanceDaily's upsert gives for
-- free via its unique key. There is no UPDATE path here by design.

CREATE TABLE payroll_entries (
  id                             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payroll_period_id              bigint NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  employee_id                    bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  employee_code                  text NOT NULL,
  employee_name                  text NOT NULL,
  wage_type                      text NOT NULL CHECK (wage_type IN ('monthly', 'daily')),
  -- Monthly-only: calendar days this employee held the job within the
  -- period's window, and whether that equals the whole window. is_full_period
  -- is what canonically decides the proration branch, not a comparison
  -- against period length done again on read.
  employed_days                  numeric(5, 2),
  is_full_period                 boolean,
  -- Daily-only: how many attendance_daily days were paid, and how many were
  -- covered by paid leave (priced separately — see payrollEntryQueries.ts).
  work_days                      numeric(5, 2),
  paid_leave_days                numeric(5, 2),
  -- Both wage types: absence for a monthly employee, or informational only
  -- for a daily one (a daily employee's absence already shows up as a day
  -- with no work_days entry, so no deduction line is needed for them).
  absent_days                    numeric(5, 2) NOT NULL DEFAULT 0,
  late_minutes_total             integer NOT NULL DEFAULT 0,
  late_minutes_deducted          integer NOT NULL DEFAULT 0,
  early_leave_minutes_total      integer NOT NULL DEFAULT 0,
  early_leave_minutes_deducted   integer NOT NULL DEFAULT 0,
  gross_earnings                 numeric(12, 2) NOT NULL DEFAULT 0,
  total_deductions                numeric(12, 2) NOT NULL DEFAULT 0,
  net_pay                        numeric(12, 2) NOT NULL DEFAULT 0,
  -- True when a day in this employee's period fell on attendance_status
  -- 'incomplete' or 'unscheduled_work' — statuses Phase 2 deliberately does
  -- not guess a wage for (see the plan's open question #2). Surfaces the row
  -- to HR instead of silently paying or not paying it.
  needs_review                   boolean NOT NULL DEFAULT false,
  calculated_at                  timestamptz NOT NULL DEFAULT now(),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_entries_minutes_range CHECK (
    late_minutes_total >= 0 AND late_minutes_deducted >= 0 AND
    early_leave_minutes_total >= 0 AND early_leave_minutes_deducted >= 0 AND
    late_minutes_deducted <= late_minutes_total AND
    early_leave_minutes_deducted <= early_leave_minutes_total
  ),
  CONSTRAINT payroll_entries_days_non_negative CHECK (
    (employed_days IS NULL OR employed_days >= 0) AND
    (work_days IS NULL OR work_days >= 0) AND
    (paid_leave_days IS NULL OR paid_leave_days >= 0) AND
    absent_days >= 0
  )
);

-- One entry per employee per period — the same row a recalculate deletes and
-- reinserts, never two.
CREATE UNIQUE INDEX payroll_entries_period_employee_key
  ON payroll_entries (payroll_period_id, employee_id);

-- The period-detail screen's entry table, and "find this employee across
-- every period they've been paid in" both need this direction.
CREATE INDEX payroll_entries_employee_idx
  ON payroll_entries (employee_id, payroll_period_id);
