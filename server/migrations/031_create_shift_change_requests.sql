-- Shift change requests (ขอเปลี่ยนกะ): the employee-initiated counterpart to
-- POST /api/employees/:id/shift-changes, on the same decision-workflow model
-- as leave_requests — pending/approved/rejected/cancelled, decided once. The
-- one extra capability past leave_requests: an employee may *edit* their own
-- request (requested_date/new_shift_id/reason/attachment) any number of
-- times while it's still pending, not just cancel it — see
-- PUT /shift-change-requests/:id.
--
-- Always for a single calendar day: approval turns it into a temporary swap
-- via createShiftChange(effectiveFrom = effectiveTo = requested_date), which
-- auto-reverts the employee to their standing shift the day after — see that
-- function's comment in shiftAssignmentQueries.ts. current_shift_id is a
-- snapshot of the shift in effect on requested_date at submission time,
-- purely for display ("changing from X"); it plays no role in approval,
-- which re-derives the actual baseline itself via createShiftChange.
--
-- attachment_key is an R2 object key, same pattern as employees.photo_key —
-- optional, one photo per request, no separate attachments table since
-- nothing else in this schema needs more than one attachment per row.
--
-- resulting_assignment_id points at the employee_shift_assignments row
-- approval creates, mirroring leave_balance_entry_id on leave_requests.
--
-- The decision_consistency CHECK follows leave_requests' four-state pattern:
-- pending and cancelled share the same "nothing decided yet" shape.

CREATE TABLE shift_change_requests (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id              bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  requested_date           date NOT NULL,
  current_shift_id         bigint REFERENCES master_shifts(id) ON DELETE RESTRICT,
  new_shift_id             bigint NOT NULL REFERENCES master_shifts(id) ON DELETE RESTRICT,
  reason                   text NOT NULL,
  attachment_key           text,
  status                   text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by_oid           text,
  decided_by_name          text,
  decided_at               timestamptz,
  decision_reason          text,
  resulting_assignment_id  bigint REFERENCES employee_shift_assignments(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_change_requests_decision_consistency CHECK (
    (status IN ('pending', 'cancelled') AND decided_by_oid IS NULL     AND decided_at IS NULL     AND decision_reason IS NULL     AND resulting_assignment_id IS NULL) OR
    (status = 'approved'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NULL     AND resulting_assignment_id IS NOT NULL) OR
    (status = 'rejected'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND resulting_assignment_id IS NULL)
  )
);

-- An employee's own request history, most recent first.
CREATE INDEX shift_change_requests_employee_idx
  ON shift_change_requests (employee_id, created_at DESC);

-- Admin's review queue, filtered by status, most recent first.
CREATE INDEX shift_change_requests_status_idx
  ON shift_change_requests (status, created_at DESC);
