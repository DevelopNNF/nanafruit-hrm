-- Supports admin-initiated time-correction requests: a supervisor/HR/Admin
-- filing a correction on behalf of one employee from admin/.
--
-- created_by_oid/created_by_name record who filed it when that is not the
-- employee themselves — null means "the employee filed this one" (LIFF
-- self-service), which covers every row before this migration and every
-- future self-service request. Mirrors overtime_requests' columns of the
-- same name and reasoning (migration 061).

ALTER TABLE time_correction_requests
  ADD COLUMN created_by_oid text,
  ADD COLUMN created_by_name text;
