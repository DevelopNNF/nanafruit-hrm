-- Job Master, the first table under the "Master" section of admin/.
--
-- master_ prefix rather than a bare `jobs`: this is the first of a family of
-- reference tables (department, etc. later) that back the collapsible
-- "Master" sidebar group, and the prefix keeps them grouped and distinguishable
-- from operational tables like employees at a glance.
--
-- No soft-delete column and no DELETE route: retiring a job is done by turning
-- is_active off, since a job can already be referenced elsewhere (employment_details
-- carries a job title today, and a future FK would only ever point at a live row).

CREATE TABLE master_jobs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_title         text NOT NULL,
  job_description   text,
  -- HTML from the Work Instruction rich text editor in admin/.
  work_instruction  text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX master_jobs_job_title_key ON master_jobs (job_title);
