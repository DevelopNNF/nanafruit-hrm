-- Assigns an employee to an overtime group, mirroring
-- 018_link_employment_details_to_holiday_group.sql exactly: nullable, since
-- an employee can exist before HR has decided which OT rate schedule applies
-- to them, and ON DELETE RESTRICT because there is no DELETE route for
-- master_overtime_groups (is_active is the retirement mechanism), so this
-- only ever matters if a row is removed by hand.

ALTER TABLE employment_details
  ADD COLUMN overtime_group_id bigint REFERENCES master_overtime_groups(id) ON DELETE RESTRICT;

CREATE INDEX employment_details_overtime_group_id_idx ON employment_details (overtime_group_id);
