-- Holiday Group Master (กลุ่มวันหยุด), e.g. Office vs Factory — the fifth
-- table under the "Master" section of admin/. A group is the thing an
-- employee is assigned to (see employment_details.holiday_group_id in
-- migration 018); the actual dates live one level down, in master_holidays.
--
-- No soft-delete column and no DELETE route: retiring a group is done by
-- turning is_active off, matching every other master table. Unlike a single
-- holiday date, a group is referenced by employment_details, so it keeps the
-- same is_active lifecycle as master_jobs/master_shifts/master_locations
-- rather than the hard-delete master_holidays gets.

CREATE TABLE master_holiday_groups (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_code  text NOT NULL,
  group_name  text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX master_holiday_groups_group_code_key ON master_holiday_groups (group_code);
