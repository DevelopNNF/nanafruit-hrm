-- Why an entry was flagged needs_review, not just that it was.
--
-- calculatePayrollEntries (payrollEntryQueries.ts) sets needs_review for five
-- distinct reasons — an incomplete punch, work on an unscheduled day, a
-- present day with no wage on file, a late/early deduction it could not
-- price, or a wage_type that changed mid-period. Without this column the
-- badge on the entries table said only "something is wrong here", which
-- sends HR back to the raw attendance report to rediscover what calculate
-- already knew at the moment it ran.
--
-- jsonb, same as audit_log.detail: a small array of {code, workDates}, one
-- entry per reason actually triggered (not one row per reason code — a
-- period with no incomplete days simply has no 'incomplete_day' entry).
-- workDates is empty for a period-level reason (mixed_wage_type has no
-- single date to point at). Reason codes are English slugs; the Thai wording
-- lives in admin/, matching every other enum-ish value in this schema.

ALTER TABLE payroll_entries
  ADD COLUMN review_reasons jsonb NOT NULL DEFAULT '[]'::jsonb;
