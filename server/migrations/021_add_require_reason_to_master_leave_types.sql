-- Leave Request phase: whether a leave type forces the employee to type a
-- reason on the LIFF form, checked in application code against
-- leave_requests.reason (which stays nullable at the DB level — the same
-- split already used for leave_balance_entries_adjustment_reason).

ALTER TABLE master_leave_types
  ADD COLUMN require_reason boolean NOT NULL DEFAULT false;
