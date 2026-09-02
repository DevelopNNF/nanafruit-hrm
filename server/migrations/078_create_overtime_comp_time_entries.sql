-- Comp-time-off balance ledger: same append-only, no-UPDATE/DELETE spirit as
-- leave_balance_entries (020) — a balance is derived by summing this table,
-- never a mutable "remaining" number, so corrections are offsetting entries,
-- not edits. Tracked in MINUTES, not days (unlike leave_balance_entries),
-- matching how OT accrues it (see overtimeCalculation.ts's comp-time split
-- functions) and how comp_time_off_requests spends it.
--
-- entry_type:
--   'accrual'    — posted when an overtime_requests row with
--                   comp_time_requested = true is approved (one accrual per
--                   request, enforced by the partial unique index below).
--   'usage'      — posted when a comp_time_off_requests row is approved.
--   'adjustment' — any manual correction (e.g. to compensate for a punch
--                   correction made after an accrual was already frozen —
--                   see overtime_requests.comp_time_accrual_minutes' comment).
--                   Reason is mandatory, same reasoning as
--                   leave_balance_entries' identical constraint.
--
-- year scopes BOTH the annual accrual cap check (master_overtime_groups.
-- comp_annual_cap_minutes) AND the spendable balance itself: per HR's
-- confirmed decision, unused comp-time-off is cut off and reset every
-- January 1st — there is no carry-over the way leave_balance_entries has.
-- This means both the cap check and "how much can this employee redeem
-- right now" reduce to the SAME query — SUM(amount_minutes) WHERE
-- employee_id = $1 AND year = $currentYear — and, unlike leave balances,
-- comp-time needs no year-end carry-over batch job at all: a prior year's
-- entries simply fall outside next year's WHERE clause on their own.
--
-- source_overtime_request_id / source_redemption_id trace an entry back to
-- what caused it (never both — see the source-matches-type CHECK), the same
-- back-link role leave_requests.leave_balance_entry_id plays in the other
-- direction. ON DELETE RESTRICT: neither overtime_requests nor
-- comp_time_off_requests has a delete route, and a ledger entry must never
-- lose its provenance if that ever changes.

CREATE TABLE overtime_comp_time_entries (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id                 bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  year                        integer NOT NULL,
  entry_type                  text NOT NULL CHECK (entry_type IN ('accrual', 'usage', 'adjustment')),
  amount_minutes              integer NOT NULL,
  source_overtime_request_id  bigint REFERENCES overtime_requests(id) ON DELETE RESTRICT,
  source_redemption_id        bigint REFERENCES comp_time_off_requests(id) ON DELETE RESTRICT,
  reason                      text,
  created_by_oid              text NOT NULL,
  created_by_name             text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT overtime_comp_time_entries_amount_sign CHECK (
    (entry_type = 'accrual' AND amount_minutes > 0) OR
    (entry_type = 'usage'   AND amount_minutes < 0) OR
    entry_type = 'adjustment'
  ),
  CONSTRAINT overtime_comp_time_entries_adjustment_reason CHECK (
    entry_type <> 'adjustment' OR reason IS NOT NULL
  ),
  CONSTRAINT overtime_comp_time_entries_source_matches_type CHECK (
    (entry_type = 'accrual'    AND source_overtime_request_id IS NOT NULL AND source_redemption_id IS NULL) OR
    (entry_type = 'usage'      AND source_redemption_id IS NOT NULL AND source_overtime_request_id IS NULL) OR
    (entry_type = 'adjustment' AND source_overtime_request_id IS NULL AND source_redemption_id IS NULL)
  )
);

-- Every read this phase does — the balance summary — is scoped to one
-- employee, one year, same shape as leave_balance_entries' identical index.
CREATE INDEX overtime_comp_time_entries_employee_year_idx
  ON overtime_comp_time_entries (employee_id, year);

-- An approved OT request accrues at most once: re-approving is not a route
-- that exists, but this guards against the approval handler ever being
-- called twice for the same request (e.g. a retried request after a
-- timeout) silently double-crediting the ledger.
CREATE UNIQUE INDEX overtime_comp_time_entries_one_accrual_per_request
  ON overtime_comp_time_entries (source_overtime_request_id) WHERE entry_type = 'accrual';

-- Same for redemption: a comp_time_off_requests row is approved at most once.
CREATE UNIQUE INDEX overtime_comp_time_entries_one_usage_per_redemption
  ON overtime_comp_time_entries (source_redemption_id) WHERE entry_type = 'usage';
