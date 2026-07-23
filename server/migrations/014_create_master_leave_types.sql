-- Leave Type Master (ประเภทการลา), the fourth table under the "Master"
-- section of admin/ — configuration rules for a leave type, not the request
-- workflow itself (that's a later phase, on the model of
-- time_correction_requests) and not an employee's balance/quota (also later:
-- quota commonly varies by tenure/level, which doesn't belong on a type-wide
-- row like this one).
--
-- min_leave_days/max_leave_days are numeric(4,2)/numeric(5,2) rather than
-- integer so half-day requests (allow_half_day) can be expressed as 0.5.
-- max_leave_days is the cap on a single request, not an annual quota — see
-- the comment above; it is nullable because not every type caps a request
-- (e.g. sick leave has no per-request ceiling in Thai practice).
--
-- gender defaults to 'all': most leave types apply regardless of gender, and
-- 'male'/'female' exist for the minority that don't (ลาคลอด, ลาบวช). This
-- compares against employees.gender (added in 013), which is nullable — an
-- employee with no gender on file simply can't be matched against a
-- restricted type yet; that check lives in application code, not here.
--
-- is_count_holiday/is_count_weekend are stored now but not consumed by any
-- day-counting logic yet — there is no public-holiday calendar in this
-- system yet either. They become meaningful once both the holiday calendar
-- and the leave-request/day-calculation phase exist.
--
-- No soft-delete column and no DELETE route: retiring a leave type is done by
-- turning is_active off, matching master_jobs/master_shifts/master_locations.

CREATE TABLE master_leave_types (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  leave_code           text NOT NULL,
  leave_name           text NOT NULL,
  is_paid              boolean NOT NULL DEFAULT true,
  allow_half_day       boolean NOT NULL DEFAULT false,
  allow_hourly         boolean NOT NULL DEFAULT false,
  min_leave_days       numeric(4,2) NOT NULL DEFAULT 0.5,
  max_leave_days       numeric(5,2),
  advance_notice_days  integer NOT NULL DEFAULT 0,
  gender               text NOT NULL DEFAULT 'all' CHECK (gender IN ('all', 'male', 'female')),
  is_count_holiday     boolean NOT NULL DEFAULT false,
  is_count_weekend     boolean NOT NULL DEFAULT false,
  sort_order           integer NOT NULL DEFAULT 0,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT master_leave_types_min_leave_days_positive CHECK (min_leave_days > 0),
  CONSTRAINT master_leave_types_max_leave_days_range CHECK (
    max_leave_days IS NULL OR max_leave_days >= min_leave_days
  ),
  CONSTRAINT master_leave_types_advance_notice_days_non_negative CHECK (advance_notice_days >= 0)
);

CREATE UNIQUE INDEX master_leave_types_leave_code_key ON master_leave_types (leave_code);
