-- Adds an optional supervisor-approval stage in front of the existing
-- HR/Admin decision on leave_requests: ผู้ขอ → หัวหน้างาน → HR/Admin when the
-- employee has one, ผู้ขอ → HR/Admin directly when they don't (no
-- employment_details.supervisor_employee_id).
--
-- requires_supervisor_approval + supervisor_employee_id are both snapshotted
-- at submission time from employment_details.supervisor_employee_id, the
-- same reasoning as every other snapshot in this table (leave_type's rules,
-- the employee's shift/holiday group via total_days): a reorg after the
-- request was filed must not retroactively change who was supposed to act on
-- it. They rise and fall together — requires_supervisor_approval is really
-- just "supervisor_employee_id is not null", kept as its own column so the
-- CHECK constraints below can name the case without repeating the null test.
--
-- current_stage says who needs to act right now; NULL once status leaves
-- 'pending'. It does not distinguish "never needed a supervisor" from
-- "supervisor already signed off" — both look like current_stage = 'hr' —
-- because nothing downstream needs that distinction once the request has
-- reached HR: HR's decision is unconditional either way, per the confirmed
-- rule that HR/Admin may act at any stage (see below).
--
-- supervisor_approved_by_* records only the FORWARDING approval — a
-- supervisor saying yes and passing the request on to HR. A supervisor's
-- rejection needs no separate record here: it is terminal, and the existing
-- decided_by_oid/decided_by_name/decided_at/decision_reason columns already
-- capture "who made the final call", whether that call came from a
-- supervisor's reject, HR/Admin's ordinary decision, or an HR/Admin override
-- made while current_stage was still 'supervisor' (confirmed: HR/Admin may
-- override at any stage, so decided_by_* is not always preceded by a
-- supervisor_approved_by_* row even when requires_supervisor_approval is
-- true).
--
-- No FK-level guard against an inactive or since-removed supervisor: if
-- employment_details.supervisor_employee_id was never updated after that
-- person left, the request just sits at current_stage = 'supervisor'
-- indefinitely — confirmed acceptable, since HR/Admin's override means it is
-- never actually stuck, only slower than the ordinary path.

ALTER TABLE leave_requests
  ADD COLUMN requires_supervisor_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN supervisor_employee_id       bigint REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN current_stage                text CHECK (current_stage IN ('supervisor', 'hr')),
  ADD COLUMN supervisor_approved_by_oid   text,
  ADD COLUMN supervisor_approved_by_name  text,
  ADD COLUMN supervisor_approved_at       timestamptz;

-- Backfill: every request already sitting pending before this migration had
-- no supervisor stage (the feature didn't exist yet), so it goes straight to
-- 'hr' — the same place a no-supervisor request lands under the new rule.
-- Decided/cancelled rows keep current_stage NULL, same as any terminal row
-- going forward.
UPDATE leave_requests SET current_stage = 'hr' WHERE status = 'pending';

ALTER TABLE leave_requests
  -- pending has a stage; nothing else does.
  ADD CONSTRAINT leave_requests_stage_consistency CHECK (
    (status = 'pending') = (current_stage IS NOT NULL)
  ),
  -- The two snapshot columns rise and fall together.
  ADD CONSTRAINT leave_requests_supervisor_requirement CHECK (
    requires_supervisor_approval = (supervisor_employee_id IS NOT NULL)
  ),
  -- Still waiting on the supervisor means they haven't forwarded it yet.
  ADD CONSTRAINT leave_requests_supervisor_stage_pending CHECK (
    current_stage IS DISTINCT FROM 'supervisor' OR supervisor_approved_by_oid IS NULL
  ),
  -- The three supervisor_approved_by_* columns are all-or-nothing.
  ADD CONSTRAINT leave_requests_supervisor_approval_consistency CHECK (
    (supervisor_approved_by_oid IS NULL AND supervisor_approved_by_name IS NULL AND supervisor_approved_at IS NULL) OR
    (supervisor_approved_by_oid IS NOT NULL AND supervisor_approved_by_name IS NOT NULL AND supervisor_approved_at IS NOT NULL)
  ),
  -- Can't have forwarded through a stage that was never required.
  ADD CONSTRAINT leave_requests_supervisor_approval_requires_flag CHECK (
    supervisor_approved_by_oid IS NULL OR requires_supervisor_approval
  );

-- The supervisor's own inbox: "requests currently waiting on me". Partial on
-- current_stage = 'supervisor' since that's the only state this index serves
-- — once a request leaves that stage it's found through the existing
-- status_idx like everything else.
CREATE INDEX leave_requests_supervisor_pending_idx
  ON leave_requests (supervisor_employee_id, created_at DESC)
  WHERE current_stage = 'supervisor';
