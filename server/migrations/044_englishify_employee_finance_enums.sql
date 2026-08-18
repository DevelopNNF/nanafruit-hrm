-- Replaces the value set of all four enum columns on employee_finance with
-- English slugs: wage_type, payment_method, social_security_type, tax_type.
-- Same shape of change as 030_update_employment_type_values.sql (which went
-- the other way, for employment_type), and the same ordering rule — the old
-- CHECK has to go before the UPDATEs, or it rejects the very rows they are
-- remapping into it.
--
-- Why: server code branches on these values, and the Thai wording is also
-- what HR reads on screen. Those are two different jobs for one string, and
-- they conflict the moment somebody wants to reword a label — today that is
-- a migration rewriting every row plus its constraint. After this, the stored
-- value is a stable identifier and the Thai lives in the frontend, which is
-- how master_finance_items and master_leave_types.gender already work.
--
-- All four columns are done together on purpose. Doing only wage_type would
-- leave the table half English and half Thai, which is worse than either.
--
-- The two *_consistency constraints embed a literal value each, so they have
-- to be dropped and rebuilt around the new slugs as well — they are the
-- reason this file drops six constraints rather than four.
--
-- Deploy note: this migration and the code that reads these columns must ship
-- together. The read path casts (`row.wage_type as WageType`) rather than
-- validating, so a mismatch does not throw — old code against new data would
-- silently take the wrong branch in wageRate.ts and price every monthly
-- employee's hour as if it were a daily wage.

ALTER TABLE employee_finance DROP CONSTRAINT employee_finance_wage_type_check;
ALTER TABLE employee_finance DROP CONSTRAINT employee_finance_payment_method_check;
ALTER TABLE employee_finance DROP CONSTRAINT employee_finance_social_security_type_check;
ALTER TABLE employee_finance DROP CONSTRAINT employee_finance_tax_type_check;
ALTER TABLE employee_finance DROP CONSTRAINT social_security_fixed_amount_consistency;
ALTER TABLE employee_finance DROP CONSTRAINT tax_fixed_amount_consistency;

--   รายเดือน -> monthly
--   รายวัน   -> daily
UPDATE employee_finance SET wage_type = 'monthly' WHERE wage_type = 'รายเดือน';
UPDATE employee_finance SET wage_type = 'daily'   WHERE wage_type = 'รายวัน';

--   เงินสด -> cash
--   โอน    -> transfer
--   เช็ค    -> cheque
UPDATE employee_finance SET payment_method = 'cash'     WHERE payment_method = 'เงินสด';
UPDATE employee_finance SET payment_method = 'transfer' WHERE payment_method = 'โอน';
UPDATE employee_finance SET payment_method = 'cheque'   WHERE payment_method = 'เช็ค';

--   ไม่คิดประกันสังคม                                  -> none
--   คิดตามฐานเงินเดือนจริงที่ได้รับ (หักจากค่าจ้าง)      -> actual_wage_employee_paid
--   คิดตามฐานเงินเดือนจริงที่ได้รับ (บริษัทจ่ายให้)       -> actual_wage_company_paid
--   คิดตามมาตรา 39                                   -> section_39
--   คิดคงที่ทุกเดือน                                    -> fixed_monthly
--   คิดตามสูตรคำนวณ                                   -> formula
UPDATE employee_finance SET social_security_type = 'none'
  WHERE social_security_type = 'ไม่คิดประกันสังคม';
UPDATE employee_finance SET social_security_type = 'actual_wage_employee_paid'
  WHERE social_security_type = 'คิดตามฐานเงินเดือนจริงที่ได้รับ (หักจากค่าจ้าง)';
UPDATE employee_finance SET social_security_type = 'actual_wage_company_paid'
  WHERE social_security_type = 'คิดตามฐานเงินเดือนจริงที่ได้รับ (บริษัทจ่ายให้)';
UPDATE employee_finance SET social_security_type = 'section_39'
  WHERE social_security_type = 'คิดตามมาตรา 39';
UPDATE employee_finance SET social_security_type = 'fixed_monthly'
  WHERE social_security_type = 'คิดคงที่ทุกเดือน';
UPDATE employee_finance SET social_security_type = 'formula'
  WHERE social_security_type = 'คิดตามสูตรคำนวณ';

--   ไม่คิดภาษี                                  -> none
--   คิดภาษี ภงด.1 ใหม่ทุกเดือน (หักจากค่าจ้าง)   -> monthly_recalc_employee_paid
--   คิดภาษี ภงด.1 ใหม่ทุกเดือน (บริษัทจ่ายให้)    -> monthly_recalc_company_paid
--   คิดภาษี ภงด.1 คงที่ทุกเดือน                  -> fixed_monthly
--   คิดภาษี ภงด.1 เป็น % ของรายได้               -> percent_of_income
UPDATE employee_finance SET tax_type = 'none'
  WHERE tax_type = 'ไม่คิดภาษี';
UPDATE employee_finance SET tax_type = 'monthly_recalc_employee_paid'
  WHERE tax_type = 'คิดภาษี ภงด.1 ใหม่ทุกเดือน (หักจากค่าจ้าง)';
UPDATE employee_finance SET tax_type = 'monthly_recalc_company_paid'
  WHERE tax_type = 'คิดภาษี ภงด.1 ใหม่ทุกเดือน (บริษัทจ่ายให้)';
UPDATE employee_finance SET tax_type = 'fixed_monthly'
  WHERE tax_type = 'คิดภาษี ภงด.1 คงที่ทุกเดือน';
UPDATE employee_finance SET tax_type = 'percent_of_income'
  WHERE tax_type = 'คิดภาษี ภงด.1 เป็น % ของรายได้';

-- Fails loudly if any row escaped the remaps above, rather than letting the
-- CHECKs below reject it with a message that names a constraint instead of
-- the value that got missed.
DO $$
DECLARE stragglers text;
BEGIN
  SELECT string_agg(DISTINCT format('%s=%L', col, val), ', ')
  INTO stragglers
  FROM (
    SELECT 'wage_type' AS col, wage_type AS val FROM employee_finance
      WHERE wage_type NOT IN ('monthly', 'daily')
    UNION ALL
    SELECT 'payment_method', payment_method FROM employee_finance
      WHERE payment_method NOT IN ('cash', 'transfer', 'cheque')
    UNION ALL
    SELECT 'social_security_type', social_security_type FROM employee_finance
      WHERE social_security_type NOT IN ('none', 'actual_wage_employee_paid',
        'actual_wage_company_paid', 'section_39', 'fixed_monthly', 'formula')
    UNION ALL
    SELECT 'tax_type', tax_type FROM employee_finance
      WHERE tax_type NOT IN ('none', 'monthly_recalc_employee_paid',
        'monthly_recalc_company_paid', 'fixed_monthly', 'percent_of_income')
  ) AS unmapped;

  IF stragglers IS NOT NULL THEN
    RAISE EXCEPTION 'employee_finance rows left unmapped: %', stragglers;
  END IF;
END $$;

ALTER TABLE employee_finance
  ADD CONSTRAINT employee_finance_wage_type_check CHECK (
    wage_type IN ('monthly', 'daily')
  );

ALTER TABLE employee_finance
  ADD CONSTRAINT employee_finance_payment_method_check CHECK (
    payment_method IN ('cash', 'transfer', 'cheque')
  );

ALTER TABLE employee_finance
  ADD CONSTRAINT employee_finance_social_security_type_check CHECK (
    social_security_type IN (
      'none',
      'actual_wage_employee_paid',
      'actual_wage_company_paid',
      'section_39',
      'fixed_monthly',
      'formula'
    )
  );

ALTER TABLE employee_finance
  ADD CONSTRAINT employee_finance_tax_type_check CHECK (
    tax_type IN (
      'none',
      'monthly_recalc_employee_paid',
      'monthly_recalc_company_paid',
      'fixed_monthly',
      'percent_of_income'
    )
  );

-- Set exactly when the type is the fixed-amount one, unchanged in meaning
-- from 033 — only the literal each one pivots on has moved.
ALTER TABLE employee_finance
  ADD CONSTRAINT social_security_fixed_amount_consistency CHECK (
    (social_security_type = 'fixed_monthly') = (social_security_fixed_amount IS NOT NULL)
  );

ALTER TABLE employee_finance
  ADD CONSTRAINT tax_fixed_amount_consistency CHECK (
    (tax_type = 'fixed_monthly') = (tax_fixed_amount IS NOT NULL)
  );
