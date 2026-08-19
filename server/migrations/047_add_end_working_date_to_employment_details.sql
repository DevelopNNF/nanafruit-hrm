-- The day an employee's employment ends, and why.
--
-- Until now the only record of someone leaving was employment_details.status
-- flipping to 'Inactive', which carries no date. That is enough for "show me
-- current staff" and not enough for anything payroll does: an employee who
-- leaves on the 12th is owed twelve days of a monthly wage, and the flag
-- cannot say which twelve. Worse, flipping the flag applies retroactively to
-- every past period at once — the person simply stops existing, including in
-- the months they were paid for.
--
-- Deliberately NOT tied to status by a CHECK. The obvious constraint —
-- "end_working_date is set exactly when status is Inactive" — rejects the
-- most common real case: an employee hands in notice on the 1st with a last
-- day at the end of the month, and is Active with an end date for all of it.
-- The pair is validated where it can be done with judgement (the API), not
-- here where it can only be done with a rule that is wrong a month at a time.
--
-- termination_reason is an English slug + CHECK rather than free text, the
-- same shape as master_finance_items.item_type and for the same two reasons:
-- code will branch on it (สปส.6-09 reports leavers by category, and the
-- Social Security Office's categories are not free text), and the Thai
-- wording HR reads stays a frontend concern. The labels live in admin/, in
-- employmentLabels.ts alongside the other employment enums.
--
-- CHECK rather than a Postgres ENUM, matching every other enum-ish column in
-- this schema: the allowed set is a first guess at the categories the company
-- actually uses, and a CHECK can be edited by a later migration where ENUM
-- values can be added but never removed. The values mirror TERMINATION_REASONS
-- in shared/src/index.ts.
--
-- Both columns nullable, with no backfill: nobody's leaving date was ever
-- recorded, and inventing one would be worse than the gap. Employees already
-- marked Inactive keep a NULL end date until HR fills it in, which is exactly
-- the list of people HR needs to work through before the first payroll period
-- closes.

ALTER TABLE employment_details
  ADD COLUMN end_working_date   date,
  ADD COLUMN termination_reason text CHECK (
    termination_reason IN (
      'resigned',        -- ลาออก
      'terminated',      -- เลิกจ้าง
      'retired',         -- เกษียณอายุ
      'contract_ended',  -- สิ้นสุดสัญญาจ้าง
      'deceased',        -- เสียชีวิต
      'other'            -- อื่นๆ
    )
  );

-- Nobody stops working before they were hired. hire_date rather than
-- start_working_date because the latter is nullable, and a constraint that
-- silently stops constraining for half the table is worse than the looser
-- bound that always holds.
ALTER TABLE employment_details
  ADD CONSTRAINT employment_details_end_after_hire CHECK (
    end_working_date IS NULL OR end_working_date >= hire_date
  );

-- A reason without a date says someone left but not when, which is the gap
-- this migration exists to close. A date without a reason is allowed: HR
-- knows the last day before they know how it will be categorised for สปส.
ALTER TABLE employment_details
  ADD CONSTRAINT employment_details_termination_reason_needs_date CHECK (
    termination_reason IS NULL OR end_working_date IS NOT NULL
  );

-- "Who is leaving soon" and "who left in this period" — the second is what
-- every payroll period will ask when it works out proration. Partial: the
-- vast majority of rows have no end date at all.
CREATE INDEX employment_details_end_working_date_idx
  ON employment_details (end_working_date)
  WHERE end_working_date IS NOT NULL;
