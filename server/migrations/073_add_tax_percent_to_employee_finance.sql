-- Adds the percentage figure for tax_type = 'percent_of_income'
-- ("คิดภาษี ภงด.1 เป็น % ของรายได้"), the one TAX_TYPES value that has been
-- storable since 033/044 but had no field to carry its own number — unlike
-- 'fixed_monthly', which got tax_fixed_amount from the start.
--
-- Same shape as tax_fixed_amount: nullable, set exactly when tax_type is the
-- one value that needs it, enforced by a *_consistency CHECK rather than
-- convention.

ALTER TABLE employee_finance
  ADD COLUMN tax_percent numeric(5, 2)
    CHECK (tax_percent IS NULL OR (tax_percent > 0 AND tax_percent <= 100));

ALTER TABLE employee_finance
  ADD CONSTRAINT tax_percent_consistency CHECK (
    (tax_type = 'percent_of_income') = (tax_percent IS NOT NULL)
  );
