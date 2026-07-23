-- Individual holiday dates within a group (วันหยุด). Plain dates, entered
-- fresh each year — no recurrence logic: Thailand's official holiday list
-- (and each company's substitution days on top of it) changes year to year,
-- so trying to auto-generate "the same day every year" would be wrong as
-- often as it was right.
--
-- No is_active column and no toggle route, unlike every other master table
-- in this system: nothing holds a foreign key to one specific holiday row
-- (employment_details points at the group, migration 018, never at a single
-- date), so there is nothing a "retire, don't delete" discipline is
-- protecting here. A wrongly-entered or since-cancelled date is just deleted.
--
-- ON DELETE CASCADE on group_id: a holiday row's entire reason to exist is
-- the group it lists dates for, and master_holiday_groups has no delete
-- route today — but if that ever changes, there is no orphaned-row state
-- worth preserving here, same reasoning as time_correction_requests.employee_id.
--
-- unique(group_id, holiday_date) catches the data-entry mistake of listing
-- the same date twice for one group; the same date under two different
-- groups is legitimate (e.g. 1 Jan is a holiday for both Office and Factory)
-- and stays two separate rows.

CREATE TABLE master_holidays (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id      bigint NOT NULL REFERENCES master_holiday_groups(id) ON DELETE CASCADE,
  holiday_name  text NOT NULL,
  holiday_date  date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX master_holidays_group_date_key ON master_holidays (group_id, holiday_date);

-- Supports "is this date a holiday for group X" lookups from the future
-- leave-day-calculation phase without scanning every row.
CREATE INDEX master_holidays_date_idx ON master_holidays (holiday_date);
