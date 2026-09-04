-- The 'paid' half of the lifecycle 050 already declared in its status CHECK
-- but never gave columns to: mirrors closed_at/closed_by_kind/closed_by_id
-- and payroll_periods_closed_pair exactly, one status earlier.
--
-- The pair CHECK covers 'closed' too, not just 'paid' — a closed period was
-- paid on its way there and must keep paid_at, so this is "paid_at is set
-- whenever status has passed through paid", not "only while status = paid".

ALTER TABLE payroll_periods
  ADD COLUMN paid_at      timestamptz,
  ADD COLUMN paid_by_kind text,
  ADD COLUMN paid_by_id   text;

ALTER TABLE payroll_periods
  ADD CONSTRAINT payroll_periods_paid_pair CHECK (
    (status IN ('paid', 'closed')) = (paid_at IS NOT NULL)
  );
