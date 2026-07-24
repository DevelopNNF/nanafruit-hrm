-- Leave balance ledger: every change to how many days of a leave type an
-- employee has, as an append-only transaction rather than a mutable
-- "remaining" number — same append-only spirit as audit_log and
-- attendance_events. A balance is SUM(amount_days) grouped by
-- (employee_id, leave_type_id, year); there is no separate "current balance"
-- row to keep in sync, so it cannot drift from its own history.
--
-- No UPDATE/DELETE route: a wrong entry is corrected by inserting a new
-- offsetting entry, not by editing or removing the mistake — the same
-- reason time_correction_requests never lets a decided row be re-decided.
--
-- entry_type:
--   'grant'      — the year's entitlement, usually amount_days = the leave
--                   type's default_days_per_year, issued via the bulk-grant
--                   action or by hand for one employee.
--   'carry_over' — unused days brought forward from a prior year. Entered by
--                   hand in this phase; there is no automatic carry-over
--                   calculation yet.
--   'adjustment' — any manual correction HR needs to make, in either
--                   direction (topping up or clawing back) — reason is
--                   mandatory here because, unlike grant/carry_over, there is
--                   no other record of why the number changed.
--   'usage'      — a day consumed by an approved leave request. Nothing in
--                   this schema creates one yet: there is no leave-request
--                   workflow. The value exists now so that phase, whenever
--                   it lands, only has to insert a row of a kind this table
--                   already understands, not add a migration of its own.
--
-- The sign CHECK ties direction to entry_type so a bug can't credit a
-- withdrawal or debit a grant: grant/carry_over must be positive, usage must
-- be negative, adjustment is the only kind allowed either way.

CREATE TABLE leave_balance_entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id     bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id   bigint NOT NULL REFERENCES master_leave_types(id),
  year            integer NOT NULL,
  entry_type      text NOT NULL CHECK (entry_type IN ('grant', 'carry_over', 'adjustment', 'usage')),
  amount_days     numeric(6,2) NOT NULL,
  reason          text,
  created_by_oid  text NOT NULL,
  created_by_name text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_balance_entries_amount_sign CHECK (
    (entry_type IN ('grant', 'carry_over') AND amount_days > 0) OR
    (entry_type = 'usage' AND amount_days < 0) OR
    entry_type = 'adjustment'
  ),
  CONSTRAINT leave_balance_entries_adjustment_reason CHECK (
    entry_type <> 'adjustment' OR reason IS NOT NULL
  )
);

-- Every read this phase does — the balance summary and the entry history —
-- is scoped to one employee, one leave type, one year.
CREATE INDEX leave_balance_entries_employee_type_year_idx
  ON leave_balance_entries (employee_id, leave_type_id, year);
