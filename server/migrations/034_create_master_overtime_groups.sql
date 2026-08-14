-- Overtime Group Master (กลุ่มการทำงานล่วงเวลา) — the sixth table under the
-- "Master" section of admin/. Same lifecycle shape as master_holiday_groups
-- (group_code/group_name/is_active, retired via is_active, no DELETE route),
-- but unlike Holiday there is no per-group child table: the five rate
-- multipliers and the rounding rule are one fixed set of columns per group,
-- not a list that varies in length, so they live directly on this row.
--
-- The five rates are wage multipliers (1.0, 1.5, 2.0, 3.0, ...), matching the
-- Thai Labor Protection Act's OT categories:
--   rate_ot_workday     นอกเวลา วันทำงานปกติ    — OT after hours on a normal workday
--   rate_normal_dayoff  ในเวลา นอกวันทำงาน      — in-hours pay on a scheduled day off
--   rate_ot_dayoff      นอกเวลา นอกวันทำงานปกติ — OT on a scheduled day off
--   rate_normal_holiday ในเวลา วันหยุดพิเศษ      — in-hours pay on a holiday (see master_holidays)
--   rate_ot_holiday     นอกเวลา วันหยุดพิเศษ     — OT on a holiday
-- All five are required (NOT NULL): a group with a blank category would be
-- silently ambiguous between "not applicable" and "not filled in yet" the
-- next time this table is read by the (not-yet-built) OT calculation logic.
--
-- rounding_minutes is the granularity OT time is rounded to before that
-- calculation, not a currency amount, so it is a small closed set rather
-- than a numeric range: 0 = ไม่ปัด (no rounding), 15/30/60 = nearest that
-- many minutes.

CREATE TABLE master_overtime_groups (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_code            text NOT NULL,
  group_name            text NOT NULL,
  rate_ot_workday       numeric(4, 2) NOT NULL CHECK (rate_ot_workday > 0),
  rate_normal_dayoff    numeric(4, 2) NOT NULL CHECK (rate_normal_dayoff > 0),
  rate_ot_dayoff        numeric(4, 2) NOT NULL CHECK (rate_ot_dayoff > 0),
  rate_normal_holiday   numeric(4, 2) NOT NULL CHECK (rate_normal_holiday > 0),
  rate_ot_holiday       numeric(4, 2) NOT NULL CHECK (rate_ot_holiday > 0),
  rounding_minutes      integer NOT NULL DEFAULT 0 CHECK (rounding_minutes IN (0, 15, 30, 60)),
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX master_overtime_groups_group_code_key ON master_overtime_groups (group_code);
