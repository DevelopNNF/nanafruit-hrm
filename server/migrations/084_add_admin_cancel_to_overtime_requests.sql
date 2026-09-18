-- Lets HR/Admin cancel an OT request that has ALREADY been approved (e.g. the
-- employee filed it with wrong details) — something no existing endpoint
-- covers today: the employee's own /cancel and the approval chain's /reject
-- both only work while status='pending'.
--
-- A NEW status ('revoked'), not a reuse of 'cancelled', because
-- overtime_requests_decision_consistency (migration 039) already says a
-- 'cancelled' row must have decided_by_oid/decided_at/decision_reason all
-- NULL — true for the employee's own pre-approval cancel (nothing was ever
-- decided), but exactly backwards here: this row WAS decided, and wiping
-- that to squeeze into 'cancelled' would destroy who originally approved it.
-- 'revoked' instead keeps decided_by_oid/decided_at/decision_reason exactly
-- as the approval left them — see the widened decision_consistency check
-- below, which now treats 'revoked' the same as 'approved' on that front —
-- and adds its own cancelled_by_oid/cancelled_by_name/cancelled_at/
-- cancellation_reason columns to record the separate, later act of revoking it.
ALTER TABLE overtime_requests
  ADD COLUMN cancelled_by_oid text,
  ADD COLUMN cancelled_by_name text,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancellation_reason text;

ALTER TABLE overtime_requests
  DROP CONSTRAINT overtime_requests_status_check;
ALTER TABLE overtime_requests
  ADD CONSTRAINT overtime_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'revoked'));

ALTER TABLE overtime_requests
  DROP CONSTRAINT overtime_requests_decision_consistency;
ALTER TABLE overtime_requests
  ADD CONSTRAINT overtime_requests_decision_consistency CHECK (
    (status IN ('pending', 'cancelled') AND decided_by_oid IS NULL     AND decided_at IS NULL     AND decision_reason IS NULL) OR
    (status IN ('approved', 'revoked')  AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NULL) OR
    (status = 'rejected'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
  );

-- All-or-nothing, and only for 'revoked' — same pattern as the decision
-- consistency check above, one level further in the lifecycle.
ALTER TABLE overtime_requests
  ADD CONSTRAINT overtime_requests_revocation_consistency CHECK (
    (status = 'revoked' AND cancelled_by_oid IS NOT NULL AND cancelled_by_name IS NOT NULL
      AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL) OR
    (status <> 'revoked' AND cancelled_by_oid IS NULL AND cancelled_by_name IS NULL
      AND cancelled_at IS NULL AND cancellation_reason IS NULL)
  );
