-- History of which shift applied to an employee, and when — replacing
-- employment_details.shift_id as the source of truth for "what shift is/was
-- in effect", the same way 020_create_leave_balance_entries.sql replaced a
-- mutable balance with a ledger.
--
-- Why this exists: employment_details.shift_id used to be overwritten in
-- place on every shift change, which meant the moment it changed, every past
-- attendance/leave calculation that ever reads it again would see the *new*
-- shift instead of whichever one actually applied on that day. This table
-- makes "which shift applied on date X" answerable for any X, not just now.
--
-- One row per interval a shift applied. effective_to IS NULL means "still in
-- effect, indefinitely" — there is at most one such row per employee at a
-- time (employee_shift_assignments_open_idx), because an unbounded interval
-- can only mean one thing at once. A temporary swap is not a special case at
-- the schema level: it is just a row with both dates set, immediately
-- followed by another row (inserted in the same transaction, not by a job —
-- this app has none) that reopens the shift the employee had immediately
-- before, with effective_from the day after the swap ends.
--
-- shift_id is nullable for the same reason employment_details.shift_id was:
-- not every employee has a shift assigned.
--
-- created_by_kind/created_by_id mirror audit_log's actor_kind/actor_id
-- (see 003_add_audit_log.sql) rather than duplicating an audit entry's whole
-- shape — this table's own row already says who and when for the one field
-- audit_log doesn't carry structurally (the effective date range).
--
-- ON DELETE RESTRICT on shift_id, same reasoning as employment_details and
-- attendance_events: there is no DELETE route for master_shifts.

CREATE TABLE employee_shift_assignments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id      bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_id         bigint REFERENCES master_shifts(id) ON DELETE RESTRICT,
  effective_from   date NOT NULL,
  effective_to     date,
  note             text,
  created_by_kind  text NOT NULL,
  created_by_id    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- At most one open-ended (current) assignment per employee.
CREATE UNIQUE INDEX employee_shift_assignments_open_idx
  ON employee_shift_assignments (employee_id) WHERE effective_to IS NULL;

-- "What applied on date X for this employee" — the query every read path
-- that used to join employment_details.shift_id now runs instead.
CREATE INDEX employee_shift_assignments_employee_range_idx
  ON employee_shift_assignments (employee_id, effective_from);

-- Backfill: one open-ended row per employee who already has a shift, dated
-- from their hire date. There is no earlier history to reconstruct — this is
-- the starting point going forward, not a claim about what applied before
-- today. Employees with no shift assigned get no row, same as they get no
-- shift today.
INSERT INTO employee_shift_assignments
  (employee_id, shift_id, effective_from, created_by_kind, created_by_id, note)
SELECT employee_id, shift_id, hire_date, 'system', 'migration_023',
       'backfilled from employment_details.shift_id'
FROM employment_details
WHERE shift_id IS NOT NULL;
