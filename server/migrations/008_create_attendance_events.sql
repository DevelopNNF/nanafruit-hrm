-- Time Attendance (การลงเวลา), Phase 1: raw clock events only.
--
-- Append-only event log rather than one row per employee per day: an employee
-- may clock in/out more than once in a day (a forgotten check-out corrected by
-- a fresh check-in is still a new event, not an edit — see below), and this
-- shape needs no migration to grow into that. It also matches audit_log's
-- append-only pattern already in this schema.
--
-- No UPDATE and no DELETE route: a mis-tap is corrected by a later event, not
-- by rewriting history. A correction/approval workflow (flagging a specific
-- event as mistaken, requiring a reason) is deferred — out of scope for this
-- phase, which only records what happened.
--
-- employee_id cascades on delete, same as employment_details: attendance
-- history belongs to the employee record's lifecycle, not independent of it.
--
-- shift_id is a snapshot of employment_details.shift_id at the moment of the
-- event, not a live lookup — an employee's shift assignment can change later,
-- and a future late/early/OT calculation needs to know which shift applied
-- *then*, not which one applies now. ON DELETE RESTRICT for the same reason
-- as employment_details.shift_id: there is no DELETE route for master_shifts
-- (is_active is the retirement mechanism), so this only matters if a row is
-- removed by hand.
--
-- latitude/longitude/accuracy_meters are nullable together: a clock-in still
-- has to be recorded even when the browser has no fix or the employee denies
-- location permission, so this isn't allowed to block the write. source exists
-- so a future channel (QR, admin manual entry) doesn't need a migration to add.

CREATE TABLE attendance_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id      bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  event_type       text NOT NULL CHECK (event_type IN ('check_in', 'check_out')),
  event_time       timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL DEFAULT 'liff_gps' CHECK (source IN ('liff_gps')),
  latitude         numeric(9, 6),
  longitude        numeric(9, 6),
  accuracy_meters  numeric(8, 2),
  shift_id         bigint REFERENCES master_shifts(id) ON DELETE RESTRICT,
  device_info      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_events_location_pair CHECK (
    (latitude IS NULL) = (longitude IS NULL)
  )
);

-- Covers both "what's this employee's last event" (clock-order validation,
-- the /me status screen) and admin listing filtered by employee, most-recent
-- first.
CREATE INDEX attendance_events_employee_time_idx
  ON attendance_events (employee_id, event_time DESC);

-- Admin listing filtered by a date range across all employees.
CREATE INDEX attendance_events_event_time_idx ON attendance_events (event_time DESC);
