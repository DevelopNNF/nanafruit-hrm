-- employment_details.job_title (free text) becomes job_id (bigint, FK to
-- master_jobs.id). Renamed rather than just retyped: the column no longer
-- holds a title, it holds a reference to one.
--
-- ON DELETE RESTRICT rather than CASCADE or SET NULL: there is no DELETE route
-- for master_jobs (see 004_create_master_jobs.sql — retiring a job clears
-- is_active instead), so this only ever matters if a row is removed by hand,
-- and blocking that is the safer default for a row employees still point at.
--
-- Existing rows are backfilled by matching their job_title text against
-- master_jobs.job_title. Any title with no matching row gets one created here
-- (is_active = true) so backfill can never leave an employee without a job —
-- the alternative, leaving job_id null or dropping the column regardless,
-- would either lose data silently or block the migration outright.

ALTER TABLE employment_details
  ADD COLUMN job_id bigint REFERENCES master_jobs(id) ON DELETE RESTRICT;

INSERT INTO master_jobs (job_title)
SELECT DISTINCT ed.job_title
FROM employment_details ed
LEFT JOIN master_jobs mj ON mj.job_title = ed.job_title
WHERE mj.id IS NULL;

UPDATE employment_details ed
SET job_id = mj.id
FROM master_jobs mj
WHERE mj.job_title = ed.job_title;

ALTER TABLE employment_details ALTER COLUMN job_id SET NOT NULL;
ALTER TABLE employment_details DROP COLUMN job_title;

CREATE INDEX employment_details_job_id_idx ON employment_details (job_id);
