-- Linking an employee to their LINE account.
--
-- line_user_id is the `sub` of a LINE ID token: the user's ID scoped to our
-- Login channel. It is nullable because every employee that already exists is
-- unlinked, and because an employee record is the source of truth about a person
-- whether or not they ever open the LIFF app.
--
-- UNIQUE is what enforces "one LINE account speaks for at most one employee" in
-- the database rather than in application code. Without it, two link codes used
-- from the same phone would quietly give one person two identities.

ALTER TABLE employees ADD COLUMN line_user_id text UNIQUE;

-- One-time codes HR hands to an employee so they can claim their own record.
--
-- The code is a credential — it binds whoever holds it to an employee's data —
-- so only its SHA-256 hash is stored. That is enough: the codes are ~39 bits of
-- randomness from a CSPRNG, not a password, so there is nothing to brute-force
-- offline and no reason to reach for bcrypt. The cost is that a lost code cannot
-- be looked up, only reissued, which is the right trade for a 24-hour token.
CREATE TABLE employee_link_codes (
  code_hash   text PRIMARY KEY,
  employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  -- NULL until redeemed. Kept rather than deleted so that "this code was already
  -- used" stays distinguishable from "this code never existed" for 24 hours.
  used_at     timestamptz,
  -- upn of the HR user who issued it. Text, not a foreign key: admins live in
  -- Entra, not in this database.
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX employee_link_codes_employee_id_idx ON employee_link_codes (employee_id);
