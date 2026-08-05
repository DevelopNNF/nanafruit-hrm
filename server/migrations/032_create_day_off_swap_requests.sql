-- Day-off swap requests (สลับวันหยุด): the employee-initiated counterpart
-- to shift_change_requests, but swapping *classification* rather than
-- *shift*. An employee asks to work on work_date (currently a holiday or
-- their weekly off) in exchange for taking off_date (currently a scheduled
-- workday) off instead. Two linked dates per request, fixed roles —
-- work_date always "becomes a workday", off_date always "becomes a day
-- off" — never interchangeable.
--
-- Same four-state pending/approved/rejected/cancelled decision-workflow
-- shape as shift_change_requests, including the employee's ability to
-- *edit* their own request (work_date/off_date/reason) any number of times
-- while still pending — see PUT /day-off-swap-requests/:id.
--
-- Unlike shift_change_requests, approval never writes into
-- employee_shift_assignments: which shift_id applies on work_date is
-- already resolvable for every calendar day via that same ledger regardless
-- of classification (see getShiftIdForDate) — only the *classification* of
-- work_date/off_date changes, which buildCalendarDaysForDates in
-- calendarQueries.ts reads directly off this table once status='approved',
-- the same way it already overlays approved leave_requests. So there is no
-- resulting_assignment_id column here.
--
-- work_date_original_status/work_date_original_label snapshot what
-- work_date classified as at submission time ('holiday' with its name, or
-- 'weekly_off') — purely for display, same "snapshot for display" reasoning
-- as shift_change_requests.current_shift_id: once approved,
-- buildCalendarDaysForDates no longer classifies work_date as 'holiday' or
-- 'weekly_off' (it becomes 'swap_workday'), so that historical fact would
-- otherwise be lost. off_date needs no equivalent snapshot — its status
-- before approval is always 'workday' by construction (validated at
-- submission), so there is nothing else worth remembering.

CREATE TABLE day_off_swap_requests (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id               bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date                 date NOT NULL,
  off_date                  date NOT NULL,
  work_date_original_status text NOT NULL CHECK (work_date_original_status IN ('holiday', 'weekly_off')),
  work_date_original_label  text,
  reason                    text NOT NULL,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by_oid            text,
  decided_by_name           text,
  decided_at                timestamptz,
  decision_reason           text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT day_off_swap_requests_distinct_dates CHECK (work_date <> off_date),
  CONSTRAINT day_off_swap_requests_original_label_consistency CHECK (
    (work_date_original_status = 'holiday'    AND work_date_original_label IS NOT NULL) OR
    (work_date_original_status = 'weekly_off' AND work_date_original_label IS NULL)
  ),
  CONSTRAINT day_off_swap_requests_decision_consistency CHECK (
    (status IN ('pending', 'cancelled') AND decided_by_oid IS NULL     AND decided_at IS NULL     AND decision_reason IS NULL) OR
    (status = 'approved'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NULL) OR
    (status = 'rejected'                AND decided_by_oid IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
  )
);

-- An employee's own request history, most recent first.
CREATE INDEX day_off_swap_requests_employee_idx
  ON day_off_swap_requests (employee_id, created_at DESC);

-- Admin's review queue, filtered by status, most recent first.
CREATE INDEX day_off_swap_requests_status_idx
  ON day_off_swap_requests (status, created_at DESC);
