-- Assigns each employee's employment_details to a shift, mirroring
-- 005_link_employment_details_to_master_jobs.sql — a bigint FK to
-- master_shifts.id rather than free text.
--
-- Nullable, unlike job_id: there's no prior "shift" text field to backfill
-- from, and not every employee needs one assigned right away (HR may not have
-- finished setting shifts up, or the role may not run on a fixed shift at all).
--
-- ON DELETE RESTRICT for the same reason as job_id: there is no DELETE route
-- for master_shifts (is_active is the retirement mechanism), so this only ever
-- matters if a row is removed by hand, and blocking that is the safer default
-- for a row employees still point at.

ALTER TABLE employment_details
  ADD COLUMN shift_id bigint REFERENCES master_shifts(id) ON DELETE RESTRICT;

CREATE INDEX employment_details_shift_id_idx ON employment_details (shift_id);
