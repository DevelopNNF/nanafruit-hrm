-- Assigns an employee to a payroll group, mirroring
-- 035_link_employment_details_to_overtime_group.sql: nullable, and
-- ON DELETE RESTRICT because master_payroll_groups has no DELETE route
-- (is_active is the retirement mechanism).
--
-- NULL here means "not paid by this system yet" — not "nobody filled this in".
-- That distinction is the whole point during the parallel run: every existing
-- employee starts NULL and stays NULL until HR deliberately adds them to a
-- group, so turning the system on for someone is an act of INCLUSION, one
-- person at a time. Backfilling everybody into the daily group and expecting
-- HR to remove the ones who do not belong would be the same operation with
-- the failure mode reversed — and the wrong direction pays somebody twice.
--
-- Partial index: the interesting query is always "who is in a group", never
-- "who is in no group at all", and the second set is most of the table for as
-- long as the parallel run lasts.

ALTER TABLE employment_details
  ADD COLUMN payroll_group_id bigint REFERENCES master_payroll_groups(id) ON DELETE RESTRICT;

CREATE INDEX employment_details_payroll_group_id_idx
  ON employment_details (payroll_group_id)
  WHERE payroll_group_id IS NOT NULL;
