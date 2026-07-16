-- Employee Master, MVP.
--
-- Two tables in a 1:1 relationship. employment_details.employee_id is both the
-- primary key and the foreign key, which is what enforces "at most one
-- employment record per employee" in the database rather than in application code.
--
-- Status and employment_type are text + CHECK rather than a Postgres ENUM type:
-- a CHECK is edited by a later migration, whereas ENUM values can be added but
-- never removed. The allowed values mirror the const arrays in shared/src/index.ts.

CREATE TABLE employees (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_code text NOT NULL UNIQUE,
  title         text NOT NULL,
  first_name_th text NOT NULL,
  last_name_th  text NOT NULL,
  first_name_en text NOT NULL,
  last_name_en  text NOT NULL,
  nickname      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employment_details (
  employee_id     bigint PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('Active', 'Inactive')),
  -- A hire date is a day on a calendar, not an instant: `date`, not `timestamptz`.
  hire_date       date NOT NULL,
  employment_type text NOT NULL CHECK (
    employment_type IN ('Permanent', 'Contract', 'Daily', 'Regularly')
  ),
  job_title       text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
