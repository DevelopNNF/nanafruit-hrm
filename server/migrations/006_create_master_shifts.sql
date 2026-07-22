-- Shift Master (กะการทำงาน), the second table under the "Master" section of admin/.
--
-- shift_start_time/shift_end_time/break_start_time/break_end_time are wall-clock
-- times (`time`, not `timestamptz`) — a shift recurs on whichever workdays it
-- applies to, it isn't a single instant. Same reasoning as employment_details.hire_date
-- being `date` rather than `timestamptz`.
--
-- A shift may cross midnight (e.g. 22:00-06:00): shift_end_time < shift_start_time
-- is valid and means "ends the following calendar day." That interpretation lives
-- in application code, not a CHECK constraint here.
--
-- break_start_time/break_end_time are nullable together — not every shift has a
-- break. master_shifts_break_pair enforces that both are set or neither is;
-- the rest of the break's validity (falls within the shift, start before end) is
-- application-layer, same split as the midnight-crossing rule above.
--
-- workdays is a bitmask over the 7 days of the week: Monday = bit 0 ... Sunday =
-- bit 6 (ISO week order). e.g. Mon-Fri = 0b0011111 = 31.
--
-- No soft-delete column and no DELETE route: retiring a shift is done by turning
-- is_active off, matching master_jobs.

CREATE TABLE master_shifts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_code        text NOT NULL,
  shift_name        text NOT NULL,
  shift_start_time  time NOT NULL,
  shift_end_time    time NOT NULL,
  break_start_time  time,
  break_end_time    time,
  workdays          smallint NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT master_shifts_workdays_range CHECK (workdays >= 0 AND workdays <= 127),
  CONSTRAINT master_shifts_break_pair CHECK (
    (break_start_time IS NULL) = (break_end_time IS NULL)
  )
);

CREATE UNIQUE INDEX master_shifts_shift_code_key ON master_shifts (shift_code);
