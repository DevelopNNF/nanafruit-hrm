-- Phase 3's own column, exactly as 056's comment on this table promised:
-- finance_item_id points a payslip line back at the master_finance_items row
-- it was priced from, for the lines that DO come from employee_finance_items
-- (buildFinanceItemLines in payrollEntryQueries.ts). NULL for every other
-- line — Phase 2's four core codes and Phase 3's five OT bucket codes are not
-- master_finance_items rows and never will be (see PAYROLL_ENTRY_LINE_CODES'
-- comment in shared/src/index.ts).
--
-- A pointer for traceability/filtering only ("show me every payslip line
-- that came from ค่าตำแหน่ง"), not something read back at render time —
-- item_code/item_name/item_type/amount on the row itself remain the only
-- source of truth for what was actually paid, per the snapshot rule 045 laid
-- down. ON DELETE RESTRICT, matching how master_finance_items is referenced
-- from employee_finance_items (045).

ALTER TABLE payroll_entry_lines
  ADD COLUMN finance_item_id bigint REFERENCES master_finance_items(id) ON DELETE RESTRICT;

CREATE INDEX payroll_entry_lines_finance_item_idx
  ON payroll_entry_lines (finance_item_id) WHERE finance_item_id IS NOT NULL;
