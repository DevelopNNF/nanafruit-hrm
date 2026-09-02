-- The employee's per-request choice to take OT as accrued comp-time-off
-- instead of money, plus where the resulting split lands once approved.
--
-- comp_time_requested is set at submission (or edit, while still pending) —
-- the route validates it against the employee's own overtime_group_id's
-- comp_time_enabled, the same way overtime_group_id itself is validated
-- there. It is NOT re-derived at approval time: the employee's choice, once
-- made, stands even if the group's comp-time setting changes before
-- approval (the group's rate/cap CONFIG at approval time is still what
-- prices it — only the yes/no choice itself is frozen early).
--
-- The four minute columns all stay at their 0 default until the request is
-- approved (see postCompTimeAccrualForApprovedDay, the approval-time step
-- that fills them in and posts the matching overtime_comp_time_entries
-- ledger row) — they describe an outcome, not an ask, so there is nothing
-- honest to put in them before a decision exists:
--   comp_time_allocated_normal/extra_minutes — this request's share of its
--     work-date's day-level rounded OT minutes (a day can carry several
--     requests; see allocateOvertimeDayMinutesToRequests in
--     overtimeCalculation.ts). Filled in for EVERY approved request, not
--     only comp-time ones — they record how the day was divided, which
--     payroll (Phase 6) needs regardless of this request's own choice.
--   comp_time_accrual_minutes — the comp-time-off minutes actually credited,
--     after conversion, rounding and annual-cap proration. Stays 0 forever
--     when comp_time_requested is false.
--   comp_time_money_source_minutes — the allocated minutes still priced as
--     money: all of them when comp_time_requested is false, or just the
--     cap-overflow portion when true and the cap was crossed.

ALTER TABLE overtime_requests
  ADD COLUMN comp_time_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN comp_time_allocated_normal_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN comp_time_allocated_extra_minutes  integer NOT NULL DEFAULT 0,
  ADD COLUMN comp_time_accrual_minutes          integer NOT NULL DEFAULT 0,
  ADD COLUMN comp_time_money_source_minutes     integer NOT NULL DEFAULT 0;

ALTER TABLE overtime_requests
  ADD CONSTRAINT overtime_requests_comp_time_minutes_non_negative CHECK (
    comp_time_allocated_normal_minutes >= 0 AND comp_time_allocated_extra_minutes >= 0 AND
    comp_time_accrual_minutes >= 0 AND comp_time_money_source_minutes >= 0
  ),
  ADD CONSTRAINT overtime_requests_comp_time_accrual_requires_flag CHECK (
    comp_time_requested OR comp_time_accrual_minutes = 0
  );
