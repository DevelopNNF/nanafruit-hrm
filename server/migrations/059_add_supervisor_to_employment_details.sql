-- Assigns a supervisor to an employee, as a real reference to another
-- employees row (not a free-text label) so the admin form can offer a
-- dropdown of active employees. Nullable, since HR fills this in manually
-- and most existing employees won't have one set at migration time.
--
-- ON DELETE SET NULL rather than RESTRICT (unlike the master_* FKs above):
-- employees are never hard-deleted in this system (status is the retirement
-- mechanism), so this only matters if a row is ever removed by hand, and
-- SET NULL is the safer default for a self-referential FK — it should never
-- block deleting one employee just because another one names them as
-- supervisor.
--
-- No DB-level check against self-reference (employee cannot be their own
-- supervisor) — enforced at the API layer instead, same as other
-- business-rule validation in this codebase.

ALTER TABLE employment_details
  ADD COLUMN supervisor_employee_id bigint REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX employment_details_supervisor_employee_id_idx
  ON employment_details (supervisor_employee_id)
  WHERE supervisor_employee_id IS NOT NULL;
