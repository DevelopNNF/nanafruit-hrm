-- Finance Item Master (รายการทางการเงิน) — the seventh table under the
-- "Master" section of admin/. One row per kind of money that can appear on a
-- payslip: an allowance (ค่ากะ, ค่าตำแหน่ง), a deduction (ค่าเอกสาร, ค่า กยศ.),
-- or a manually-entered tax line.
--
-- Deliberately no amount column. What an item is worth varies per employee —
-- two people on ค่าตำแหน่ง rarely get the same figure — so the amount belongs
-- on the per-employee link table (employee_finance_items) that a later phase
-- adds, not here. This table is the vocabulary; the amounts are the sentences.
--
-- item_type is stored as an English slug rather than the Thai label shown in
-- admin/, unlike employee_finance's wage_type/payment_method. Payroll code
-- branches on this value (income adds, deduction and tax subtract), and a
-- branch reads better in the same language as the code around it; it also
-- means rewording the Thai on screen is a frontend change, not a migration
-- that has to rewrite every row and the CHECK with it. The allowed values
-- mirror FINANCE_ITEM_TYPES in shared/src/index.ts.
--
-- 'tax' is separate from 'deduction' even though tax is a deduction, because
-- the two are reported apart (ภงด.1 wants the tax lines by themselves). It
-- covers manually-recorded tax only — the automatic ภงด.1 withholding is
-- already computed from employee_finance.tax_type and does not pass through
-- this table.
--
-- No soft-delete column and no DELETE route: retiring an item is done by
-- turning is_active off, matching every other master table. That matters more
-- here than elsewhere — a retired item still has to resolve for the payslips
-- that already referenced it.

CREATE TABLE master_finance_items (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_code    text NOT NULL,
  item_name    text NOT NULL,
  item_type    text NOT NULL CHECK (item_type IN ('income', 'deduction', 'tax')),
  -- Free-text note for HR: which contract a ค่า กยศ. deduction refers to, who
  -- an allowance applies to, and so on. Nothing reads it but a person.
  description  text,
  -- Display order on the payslip and on the per-employee settings screen.
  -- Same reasoning as master_leave_types.sort_order: without it the list
  -- falls back to code or id, neither of which is the order HR reads in.
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX master_finance_items_item_code_key ON master_finance_items (item_code);
