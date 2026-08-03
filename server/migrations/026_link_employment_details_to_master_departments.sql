-- employment_details gets a department_id (FK to master_departments.id),
-- required from day one — unlike job_id (005_link_employment_details_to_master_jobs.sql)
-- there's no prior free-text column to trade in, so every existing row is
-- backfilled to the UNASSIGNED department seeded in 025 before the column
-- is made NOT NULL.
--
-- ON DELETE RESTRICT: no DELETE route for master_departments (see 025 —
-- retiring one clears is_active instead), so this only ever matters if a
-- row is removed by hand, and blocking that is the safer default for a row
-- employees still point at.

ALTER TABLE employment_details
  ADD COLUMN department_id bigint REFERENCES master_departments(id) ON DELETE RESTRICT;

UPDATE employment_details
SET department_id = (SELECT id FROM master_departments WHERE dept_code = 'UNASSIGNED');

ALTER TABLE employment_details ALTER COLUMN department_id SET NOT NULL;

CREATE INDEX employment_details_department_id_idx ON employment_details (department_id);
