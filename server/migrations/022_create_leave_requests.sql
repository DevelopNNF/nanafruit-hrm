-- Leave requests (คำขอลา): the request/approval workflow for leave, on the
-- same model as time_correction_requests — append-mostly, decided once, no
-- "re-open" route. The difference from that table is the extra 'cancelled'
-- status: an employee may withdraw their own request before anyone decides
-- it, which a time correction request has no equivalent of.
--
-- start_date/end_date are the calendar range requested. start_time/end_time
-- are nullable and only set for a leave type that allows hourly leave (an
-- exact clock range within start_date) or a half-day taken as a custom time
-- rather than a plain AM/PM half — the rest of the time-of-day math (which
-- half of the shift, how many hours) lives in application code, not here.
--
-- total_days is computed once at submission time from the leave type's
-- half-day/hourly rules, the employee's shift workdays, and their holiday
-- group, then frozen — the same reasoning as requested_event_time being
-- combined once on time_correction_requests: redoing the calculation at
-- approval time would risk a different answer if the underlying master data
-- changed in between, and there would be two places a mistake could happen
-- instead of one.
--
-- leave_type_id has no ON DELETE clause (defaults to RESTRICT/NO ACTION):
-- master_leave_types has no delete route, so this can never actually fire,
-- but RESTRICT documents the intent — a leave type with requests against it
-- is not something that should ever disappear out from under them.
--
-- leave_balance_entry_id points at the 'usage' ledger row created on
-- approval, mirroring resulting_event_id on time_correction_requests. ON
-- DELETE SET NULL for the same reason as that column: leave_balance_entries
-- has no delete route today, but if that ever changes, losing the back-link
-- on a request that already did its job is not worth blocking the delete
-- over.
--
-- The decision_consistency CHECK extends time_correction_requests' pattern
-- to four states instead of three: pending and cancelled share the same
-- "nothing decided yet" shape, differing only in status itself.

CREATE TABLE leave_requests (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id            bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id          bigint NOT NULL REFERENCES master_leave_types(id),
  start_date             date NOT NULL,
  end_date               date NOT NULL,
  start_time             time,
  end_time               time,
  total_days             numeric(5,2) NOT NULL,
  reason                 text,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by_oid         text,
  decided_by_name        text,
  decided_at             timestamptz,
  decision_reason        text,
  leave_balance_entry_id bigint REFERENCES leave_balance_entries(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_requests_date_range CHECK (end_date >= start_date),
  CONSTRAINT leave_requests_total_days_positive CHECK (total_days > 0),
  CONSTRAINT leave_requests_decision_consistency CHECK (
    (status IN ('pending', 'cancelled') AND decided_by_oid IS NULL     AND decided_at IS NULL     AND decision_reason IS NULL     AND leave_balance_entry_id IS NULL) OR
    (status = 'approved'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NULL     AND leave_balance_entry_id IS NOT NULL) OR
    (status = 'rejected'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND leave_balance_entry_id IS NULL)
  )
);

-- An employee's own request history, most recent first.
CREATE INDEX leave_requests_employee_idx
  ON leave_requests (employee_id, created_at DESC);

-- Admin's review queue, filtered by status, most recent first.
CREATE INDEX leave_requests_status_idx
  ON leave_requests (status, created_at DESC);
