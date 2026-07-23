-- Time correction requests (แก้ไขเวลา): the correction/approval workflow that
-- migration 008 deferred — "flagging a specific event as mistaken, requiring
-- a reason" — now has a code path.
--
-- One row per requested event (one check-in or one check-out), not one row
-- per day: matches how attendance_events itself is one row per event, and
-- keeps the approve/reject decision scoped to a single, unambiguous event.
--
-- requested_event_time is a single timestamptz, not a separate date+time
-- pair: the employee's liff form collects a date and a time, but the server
-- combines them into one instant at submission, so approval never has to
-- redo that combination and there is only one place a timezone mistake could
-- happen, not two.
--
-- No UPDATE/DELETE by admin outside the status transition below: same
-- append-mostly spirit as attendance_events. A request is decided once —
-- there is no "re-open" or "un-approve" route.
--
-- employee_id cascades on delete, same as attendance_events: a request
-- belongs to the employee record's lifecycle, not independent of it.
--
-- resulting_event_id points at the attendance_events row created on
-- approval, so the request that caused a correction is traceable from either
-- direction. ON DELETE SET NULL rather than RESTRICT: attendance_events has
-- no delete route today, but if that ever changes, losing the back-link on a
-- request that already did its job is not worth blocking the delete over.
--
-- The decision_consistency CHECK is the single source of truth for "a
-- rejection always carries a reason, an approval always carries the event it
-- created, and a pending request carries neither" — the same role the
-- breakStartTime/breakEndTime pairing plays in master_shifts.

CREATE TABLE time_correction_requests (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id           bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  event_type            text NOT NULL CHECK (event_type IN ('check_in', 'check_out')),
  requested_event_time  timestamptz NOT NULL,
  reason                text NOT NULL,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by_oid        text,
  decided_by_name       text,
  decided_at            timestamptz,
  decision_reason       text,
  resulting_event_id    bigint REFERENCES attendance_events(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_correction_requests_decision_consistency CHECK (
    (status = 'pending'  AND decided_by_oid IS NULL     AND decided_at IS NULL     AND decision_reason IS NULL     AND resulting_event_id IS NULL) OR
    (status = 'approved' AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NULL     AND resulting_event_id IS NOT NULL) OR
    (status = 'rejected' AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND resulting_event_id IS NULL)
  )
);

-- An employee's own request history, most recent first.
CREATE INDEX time_correction_requests_employee_idx
  ON time_correction_requests (employee_id, created_at DESC);

-- Admin's review queue, filtered by status, most recent first.
CREATE INDEX time_correction_requests_status_idx
  ON time_correction_requests (status, created_at DESC);
