-- Whether an HR user has looked at this employee's payslip and confirmed it,
-- ahead of approving the whole period. A column of its own rather than
-- reusing needs_review: needs_review is what calculatePayrollEntries decides
-- on its own (five known bad shapes — see 057's migration comment), while
-- reviewed_at is a human decision that every entry needs, not just the ones
-- the system already flagged.
--
-- Nullable = not yet reviewed. There is deliberately no reviewed_by_kind/id
-- pair alongside it: payroll_periods.voided_at already set the precedent for
-- this domain of tracking "who" via audit_log alone rather than a column on
-- the row itself (voided_at has no voided_by either), and PATCH
-- /payroll-entries/:id/review records payroll_entry.review/.unreview there.
--
-- Cleared back to NULL rather than just flipped, so the same delete-and-
-- reinsert calculatePayrollEntries already does on every recalculation
-- clears it for free: a new set of entries needs a fresh look, and there is
-- nothing extra here to invalidate.

ALTER TABLE payroll_entries
  ADD COLUMN reviewed_at timestamptz;
