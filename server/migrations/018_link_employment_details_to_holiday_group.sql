-- Assigns an employee to a holiday group (Office/Factory/...), mirroring
-- 007_link_employment_details_to_master_shifts.sql — nullable like shift_id,
-- not required like job_id: an employee can exist before HR has decided
-- which holiday calendar applies to them.
--
-- ON DELETE RESTRICT for the same reason as job_id/shift_id: there is no
-- DELETE route for master_holiday_groups (is_active is the retirement
-- mechanism), so this only ever matters if a row is removed by hand, and
-- blocking that is the safer default for a row employees still point at.

ALTER TABLE employment_details
  ADD COLUMN holiday_group_id bigint REFERENCES master_holiday_groups(id) ON DELETE RESTRICT;

CREATE INDEX employment_details_holiday_group_id_idx ON employment_details (holiday_group_id);
