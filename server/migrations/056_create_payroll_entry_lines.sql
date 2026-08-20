-- The payslip lines behind one payroll_entries row. No joins out to read one
-- back — item_code/item_name/item_type/quantity/rate/amount are all
-- self-contained, per the "payslip must snapshot, not join" note left in
-- 045_create_employee_finance_items.sql for whoever built this table.
--
-- Phase 2 only ever writes four item_code values — BASIC_WAGE, ABSENCE_DEDUCT,
-- LATE_DEDUCT, EARLY_LEAVE_DEDUCT — defined as PAYROLL_ENTRY_LINE_CODES in
-- shared/src/index.ts, not rows in master_finance_items: these are core
-- payroll lines every employee can have, not HR-configured per-employee
-- allowances. Phase 3 adds finance_item_id (nullable, pointing at
-- master_finance_items) for the lines that DO come from employee_finance_items
-- — its own column added by its own migration, matching how 045/046/047 each
-- added exactly the column their phase needed rather than guessing ahead.
--
-- item_type mirrors FINANCE_ITEM_TYPES (income/deduction/tax) so a payslip
-- renderer sums both kinds of line — Phase 2's own and Phase 3's later ones —
-- with one piece of code.
--
-- amount is always positive, same convention as employee_finance_items:
-- item_type's job is the sign, so a deduction is never enterable as a
-- negative income by mistake. No zero-amount lines are written — a day with
-- no late deduction simply has no LATE_DEDUCT row, keeping the slip readable.
--
-- ON DELETE CASCADE from payroll_entries: lines never outlive the entry they
-- describe, and calculatePayrollEntries deletes+reinserts entries wholesale
-- on every recalculate while a period is still draft/calculating.

CREATE TABLE payroll_entry_lines (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payroll_entry_id  bigint NOT NULL REFERENCES payroll_entries(id) ON DELETE CASCADE,
  item_code         text NOT NULL,
  item_name         text NOT NULL,
  item_type         text NOT NULL CHECK (item_type IN ('income', 'deduction', 'tax')),
  quantity          numeric(10, 2),
  rate              numeric(12, 2),
  amount            numeric(12, 2) NOT NULL CHECK (amount > 0),
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The payslip screen's only query: every line for one entry, in display order.
CREATE INDEX payroll_entry_lines_entry_idx
  ON payroll_entry_lines (payroll_entry_id, sort_order);
