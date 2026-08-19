-- History of what an employee was paid, and when — replacing
-- employee_finance.wage_type/wage_amount as the source of truth for "what is
-- this person's wage", the same way 023_create_employee_shift_assignments.sql
-- replaced employment_details.shift_id.
--
-- Why this exists: employee_finance holds one wage with no history behind it,
-- overwritten in place on every raise. overtimeCalculation.ts's comment on
-- overtimeAmount already spells out the consequence — "a figure written down
-- in March and read back after a raise would be neither March's truth nor
-- today's" — which is why OT is priced on read rather than stored. Pricing on
-- read only helps if the wage it reads is the one that applied on the day,
-- and until this table there was no such thing. Payroll cannot be built on
-- that: a payslip for March run in April must use March's wage, forever.
--
-- One row per interval a wage applied. effective_to IS NULL means "until
-- further notice", the same convention as employee_shift_assignments and
-- employee_finance_items.
--
-- created_by_kind/created_by_id mirror audit_log's actor_kind/actor_id, same
-- as employee_shift_assignments — this row already says who and when for the
-- one field audit_log doesn't carry structurally (the effective date range).
--
-- Overlap is prevented by an EXCLUDE constraint rather than 023's partial
-- unique index plus an application check. Two reasons this table gets the
-- stronger tool:
--
--   * There is no temporary-swap case here. A shift can be swapped for a week
--     and then revert, which is why 023 needed to allow a closed interval to
--     sit inside an employee's timeline and rebuild the open one behind it. A
--     wage just changes; it never reverts on a schedule.
--   * EXCLUDE subsumes the "at most one open row" rule that 023 needed a
--     separate partial index for: two rows with a NULL upper bound are two
--     unbounded ranges, and unbounded ranges always overlap.
--
-- '[]' makes both ends inclusive, so a row ending 31 Jan and the next
-- starting 1 Feb do not collide. Same as employee_finance_items.
--
-- wage_amount is numeric(12,2) and strictly positive, matching
-- employee_finance.wage_amount, which it takes over from. wage_type's allowed
-- values mirror WAGE_TYPES in shared/src/index.ts.

-- Already installed by 045_create_employee_finance_items.sql. Repeated so
-- this file explains its own requirements: gist alone cannot index the
-- employee_id equality column.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE employee_wage_assignments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id      bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  wage_type        text NOT NULL CHECK (wage_type IN ('monthly', 'daily')),
  wage_amount      numeric(12, 2) NOT NULL CHECK (wage_amount > 0),
  effective_from   date NOT NULL,
  effective_to     date,
  note             text,
  created_by_kind  text NOT NULL,
  created_by_id    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_wage_assignments_period_order CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT employee_wage_assignments_no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);

-- "What applied on date X for this employee" — the query the overtime report
-- (and, later, every payroll period) runs once per row. The gist index the
-- EXCLUDE constraint creates can answer this too, but not as cheaply as a
-- plain btree on the columns actually filtered.
CREATE INDEX employee_wage_assignments_employee_range_idx
  ON employee_wage_assignments (employee_id, effective_from);

-- Backfill: one open-ended row per employee who already has finance data,
-- dated from the day they started working.
--
-- COALESCE(start_working_date, hire_date) rather than 023's plain hire_date:
-- 029 added start_working_date precisely because the day a contract is signed
-- and the day work begins are different, and a wage is owed from the second
-- one. It stays nullable for employees who predate that column, hence the
-- fallback.
--
-- As with 023, this is the starting point going forward, not a claim about
-- what anyone was paid before today. There is no earlier history to recover —
-- the old column only ever held one value.
INSERT INTO employee_wage_assignments
  (employee_id, wage_type, wage_amount, effective_from,
   created_by_kind, created_by_id, note)
SELECT ef.employee_id, ef.wage_type, ef.wage_amount,
       COALESCE(ed.start_working_date, ed.hire_date),
       'system', 'migration_046',
       'backfilled from employee_finance.wage_amount'
FROM employee_finance ef
JOIN employment_details ed ON ed.employee_id = ef.employee_id;

-- The old columns are now dead: nothing reads them and nothing writes them.
-- They are kept rather than dropped for the same reason 023 kept
-- employment_details.shift_id — the backfill above is derived from them, and
-- keeping the source readable costs nothing while the new table is young.
--
-- NOT NULL has to go, though, and that is not optional. The Finance tab no
-- longer collects a wage at all (it moved to its own card, the way shift
-- changes moved to ShiftHistoryCard), so PATCH /employees/:id/finance stops
-- supplying these two columns — and its upsert INSERTs a fresh row for any
-- employee saving finance data for the first time. Leaving NOT NULL in place
-- would make that insert fail for exactly the employees who have never been
-- saved before.
--
-- The CHECK constraints stay: a CHECK on a NULL column evaluates to unknown,
-- which passes, so they keep constraining the rows that still carry a value.
ALTER TABLE employee_finance ALTER COLUMN wage_type  DROP NOT NULL;
ALTER TABLE employee_finance ALTER COLUMN wage_amount DROP NOT NULL;

COMMENT ON COLUMN employee_finance.wage_type IS
  'Dead as of 046 — superseded by employee_wage_assignments. Not read, not written.';
COMMENT ON COLUMN employee_finance.wage_amount IS
  'Dead as of 046 — superseded by employee_wage_assignments. Not read, not written.';
