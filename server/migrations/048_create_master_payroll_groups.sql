-- Payroll Group Master (กลุ่มเงินเดือน) — the ninth table under the "Master"
-- section of admin/, and the answer to a question no other master table asks:
-- *which employees does a payroll run cover?*
--
-- The company is not migrating off its existing HRM in one cut. Both systems
-- run side by side, daily-paid staff first, and HR moves people over a few at
-- a time. Without something the system can read, closing a period would
-- calculate for everybody — including the people still being paid by the old
-- system — and hand out two payslips for the same month.
--
-- A boolean flag on employment_details would answer "in or out". This answers
-- "in which group", which is the question that arrives the moment monthly
-- staff follow and want a different cut-off or a different pay day. At that
-- point a flag has to be migrated; a group does not.
--
-- Same lifecycle shape as master_overtime_groups: group_code/group_name/
-- is_active, retired via is_active, no DELETE route.
--
-- cutoff_day is capped at 28 ON PURPOSE. A cut-off of the 30th does not exist
-- in February, and a payroll table is the wrong place to discover that. If the
-- company ever wants to cut off at month-end, that is a new cutoff_rule value
-- ('last_day_of_month'), not a wider number range — the same reason this
-- schema has always used CHECK rather than ENUM: a later migration can edit it.
--
-- pay_day_of_month is only meaningful when pay_day_rule = 'fixed_day', and the
-- paired CHECK makes the two impossible to disagree. Nanafruit pays on the
-- last day of the month, so 'fixed_day' has no user today; it exists because
-- "which day do we pay" belongs next to "which day do we cut off", not spread
-- between a column here and an assumption in application code.

CREATE TABLE master_payroll_groups (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_code       text NOT NULL,
  group_name       text NOT NULL,
  cutoff_day       smallint NOT NULL CHECK (cutoff_day BETWEEN 1 AND 28),
  pay_day_rule     text NOT NULL CHECK (pay_day_rule IN ('last_day_of_month', 'fixed_day')),
  pay_day_of_month smallint CHECK (pay_day_of_month BETWEEN 1 AND 31),
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT master_payroll_groups_fixed_day_needs_day CHECK (
    (pay_day_rule = 'fixed_day') = (pay_day_of_month IS NOT NULL)
  )
);

CREATE UNIQUE INDEX master_payroll_groups_group_code_key
  ON master_payroll_groups (group_code);

-- The first group that will actually be paid from this system: daily-paid
-- staff, cut off on the 25th, paid on the last day of the month. Seeded rather
-- than left to HR because the period screens are unusable without at least one
-- group, and this one's shape is already known. The name is editable from the
-- master screen — this is a starting point, not a claim about what HR calls it.
INSERT INTO master_payroll_groups (group_code, group_name, cutoff_day, pay_day_rule)
VALUES ('DAILY', 'พนักงานรายวัน', 25, 'last_day_of_month');
