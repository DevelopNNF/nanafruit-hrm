-- Department Master, joining the "Master" family started by master_jobs
-- (see 004_create_master_jobs.sql).
--
-- parent_department_id is a self-reference for the department hierarchy
-- (e.g. "Line Production" reports up to "Manufacturing"). The CHECK only
-- rules out a department pointing at itself directly — a deeper cycle
-- (A -> B -> A) can't be expressed as a single-row constraint, so that's
-- enforced in the API layer (routes/departments.ts) with a recursive walk
-- up the ancestor chain before every insert/update.
--
-- ON DELETE RESTRICT, same reasoning as master_jobs: no DELETE route exists
-- (retiring a department clears is_active instead), so this only matters if
-- a row is removed by hand, and blocking that is the safer default for a
-- row other departments or employees still point at.
--
-- The seed row below (UNASSIGNED) exists so the employment_details link
-- migration that follows has something to backfill existing employees to,
-- since department_id is required there from day one.

CREATE TABLE master_departments (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dept_code             text NOT NULL,
  dept_name             text NOT NULL,
  parent_department_id  bigint REFERENCES master_departments(id) ON DELETE RESTRICT,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_department_id IS NULL OR parent_department_id <> id)
);

CREATE UNIQUE INDEX master_departments_dept_code_key ON master_departments (dept_code);

INSERT INTO master_departments (dept_code, dept_name) VALUES ('UNASSIGNED', 'ยังไม่ระบุแผนก');
