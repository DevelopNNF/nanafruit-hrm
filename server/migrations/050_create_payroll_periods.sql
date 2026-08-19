-- One payroll period: a group, a window of days, and how far through the
-- pay-run that window has got. Nothing calculates against this table yet —
-- Phase 2 onwards does — but every payslip that will ever exist hangs off a
-- row here, which is why the shape is worth this much care now.
--
-- period_code is the month the salary is FOR, 'YYYY-MM'. The window is not
-- that month: Nanafruit cuts off on the 25th, so period '2026-08' runs
-- 2026-07-26 to 2026-08-25 and pays on 2026-08-31. The window is derived from
-- the group's cutoff_day by derivePeriodWindow() in server/src/payrollPeriod.ts
-- and then stored, not re-derived on read — a group's cutoff_day can be
-- changed, and a period that has already been paid must not silently move.
--
-- IMPORTANT: the window is NOT always 30 days. With a 26th-to-25th cut-off,
-- 2026 has seven 31-day periods, four 30-day ones, and a 28-day period in
-- March. Anything in Phase 2 that divides by 30 has to reckon with that
-- against the stored dates, not against an assumption.
--
-- status is the full pay-run lifecycle even though Phase 1 can only reach
-- 'draft' and 'voided'. The allowed transitions live in one place —
-- canTransition() in payrollPeriod.ts — and are enforced in application code
-- inside a transaction (SELECT ... FOR UPDATE, then check), the same way
-- POST /leave-requests/:id/approve guards against a double decision. There is
-- deliberately no trigger: this schema has never had one, and a state machine
-- split between a trigger and a route is a state machine nobody can read.
--
-- What IS enforced down here is the damage that survives a bug in the route:
--
--   * payroll_periods_no_overlap — two periods of the same group must not
--     share a single day, or that day gets paid twice. A unique index on
--     period_code would not catch it: mistyping period_start on the September
--     period overlaps August while keeping a perfectly unique code. Same
--     EXCLUDE USING gist reasoning as 045 and 046 (btree_gist is already
--     installed by 045).
--   * the closed/voided pairs — a period cannot be closed with nobody
--     recorded as having closed it.
--
-- Both the EXCLUDE and the unique index are partial on `status <> 'voided'`.
-- A voided period must not block re-creating the month it occupied, or one
-- mistake locks that month forever and the only fix is deleting the row — the
-- exact thing an audit trail exists to prevent.

CREATE TABLE payroll_periods (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payroll_group_id bigint NOT NULL REFERENCES master_payroll_groups(id) ON DELETE RESTRICT,
  period_code      text NOT NULL CHECK (period_code ~ '^\d{4}-\d{2}$'),
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  pay_date         date NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN (
                     'draft', 'calculating', 'review', 'approved', 'paid', 'closed', 'voided'
                   )),
  note             text,
  created_by_kind  text NOT NULL,
  created_by_id    text NOT NULL,
  closed_by_kind   text,
  closed_by_id     text,
  closed_at        timestamptz,
  voided_at        timestamptz,
  void_reason      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_periods_window_order CHECK (period_end > period_start),
  CONSTRAINT payroll_periods_pay_after_end CHECK (pay_date >= period_end),
  CONSTRAINT payroll_periods_closed_pair CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  ),
  CONSTRAINT payroll_periods_voided_pair CHECK (
    (status = 'voided') = (voided_at IS NOT NULL)
  ),
  CONSTRAINT payroll_periods_no_overlap EXCLUDE USING gist (
    payroll_group_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  ) WHERE (status <> 'voided')
);

CREATE UNIQUE INDEX payroll_periods_group_code_key
  ON payroll_periods (payroll_group_id, period_code)
  WHERE status <> 'voided';

-- "Show me this group's periods, newest first" — the period list screen.
CREATE INDEX payroll_periods_group_start_idx
  ON payroll_periods (payroll_group_id, period_start DESC);
