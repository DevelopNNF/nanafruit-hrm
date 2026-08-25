-- Links an employee record to the Entra account they sign into admin/ with,
-- so the server can resolve "which employee is this admin session" for
-- features scoped to a specific person rather than a role — starting with
-- bulk OT requests, where a supervisor may act only on their own direct
-- reports (employment_details.supervisor_employee_id), not by an Entra App
-- Role (there isn't one for "supervisor" and HR does not want to manage one
-- in the Entra portal for a handful of people).
--
-- Nullable: most employees never sign into admin/ at all. HR fills this in by
-- hand from the Employee Basic tab, same workflow as fingerprint_code — there
-- is no Entra Graph sync here, so a typo means the lookup simply misses
-- rather than granting access to the wrong person.
--
-- Compared case-insensitively at lookup time (Entra UPNs are not
-- case-sensitive), so the column is plain UNIQUE rather than a
-- lower()-expression unique index: application code lower()s and trims
-- before every write, so two rows can never differ only by case in practice,
-- and a plain column keeps the uniqueViolationField() constraint-name mapping
-- in routes/employees.ts the same shape as employee_code/id_card_number/
-- fingerprint_code.

ALTER TABLE employees
  ADD COLUMN entra_upn text UNIQUE;
