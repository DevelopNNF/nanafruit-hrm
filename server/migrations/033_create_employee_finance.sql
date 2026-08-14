-- Employee Finance: wage, bank, social security and withholding-tax settings
-- for one employee. 1:1 with employees, same PK-as-FK shape as
-- employment_details — but unlike that table, no row is created at employee
-- creation. This is a new tab added retroactively; existing employees start
-- with no row, and PATCH /employees/:id/finance upserts one on first save.
--
-- Enum columns are text + CHECK rather than a Postgres ENUM type, same
-- reasoning as employees/employment_details: a CHECK can be edited by a
-- later migration, ENUM values can only be added. The allowed values mirror
-- WAGE_TYPES/PAYMENT_METHODS/SOCIAL_SECURITY_TYPES/TAX_TYPES in
-- shared/src/index.ts.

CREATE TABLE employee_finance (
  employee_id                   bigint PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  wage_type                     text NOT NULL CHECK (wage_type IN ('รายเดือน', 'รายวัน')),
  wage_amount                   numeric(12, 2) NOT NULL CHECK (wage_amount > 0),
  payment_method                text NOT NULL CHECK (payment_method IN ('เงินสด', 'โอน', 'เช็ค')),
  -- Only SCB is supported today — see EmployeeFinance.bankName's comment.
  -- Stored (rather than hardcoded in the API) so a second bank is a data
  -- change, not a migration, once that day comes.
  bank_name                     text NOT NULL DEFAULT 'ไทยพาณิชย์ (SCB)',
  bank_branch_code              text,
  bank_account_number           text NOT NULL,
  social_security_type          text NOT NULL CHECK (
    social_security_type IN (
      'ไม่คิดประกันสังคม',
      'คิดตามฐานเงินเดือนจริงที่ได้รับ (หักจากค่าจ้าง)',
      'คิดตามฐานเงินเดือนจริงที่ได้รับ (บริษัทจ่ายให้)',
      'คิดตามมาตรา 39',
      'คิดคงที่ทุกเดือน',
      'คิดตามสูตรคำนวณ'
    )
  ),
  -- Set exactly when social_security_type is 'คิดคงที่ทุกเดือน' — enforced
  -- below rather than merely by convention, same as leave_requests'
  -- decision_consistency CHECK.
  social_security_fixed_amount  numeric(12, 2) CHECK (social_security_fixed_amount IS NULL OR social_security_fixed_amount > 0),
  tax_type                      text NOT NULL CHECK (
    tax_type IN (
      'ไม่คิดภาษี',
      'คิดภาษี ภงด.1 ใหม่ทุกเดือน (หักจากค่าจ้าง)',
      'คิดภาษี ภงด.1 ใหม่ทุกเดือน (บริษัทจ่ายให้)',
      'คิดภาษี ภงด.1 คงที่ทุกเดือน',
      'คิดภาษี ภงด.1 เป็น % ของรายได้'
    )
  ),
  -- Set exactly when tax_type is 'คิดภาษี ภงด.1 คงที่ทุกเดือน'.
  tax_fixed_amount              numeric(12, 2) CHECK (tax_fixed_amount IS NULL OR tax_fixed_amount > 0),
  -- The calendar month withholding tax starts being calculated from, always
  -- the 1st of that month — a real date so it can compare against other
  -- dates, not a bare 1-12 month number that would be silently ambiguous
  -- across years.
  tax_start_month               date CHECK (tax_start_month IS NULL OR date_trunc('month', tax_start_month) = tax_start_month),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_security_fixed_amount_consistency CHECK (
    (social_security_type = 'คิดคงที่ทุกเดือน') = (social_security_fixed_amount IS NOT NULL)
  ),
  CONSTRAINT tax_fixed_amount_consistency CHECK (
    (tax_type = 'คิดภาษี ภงด.1 คงที่ทุกเดือน') = (tax_fixed_amount IS NOT NULL)
  )
);
