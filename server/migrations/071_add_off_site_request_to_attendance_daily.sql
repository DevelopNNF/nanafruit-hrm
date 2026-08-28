-- Snapshots whether a computed day fell inside an approved off-site work
-- request, so admin/'s attendance report can show an "ทำงานนอกสถานที่" badge
-- without re-joining off_site_work_requests at read time — same reasoning as
-- late_grace_minutes/early_leave_grace_minutes (054): the value that decided
-- this day's verdict at compute time, not whatever off_site_work_requests
-- looks like now.
--
-- SET NULL rather than RESTRICT: attendance_daily is derived data the batch
-- job freely overwrites (see 037's header comment), so a derived pointer here
-- must never block anything upstream from changing.

ALTER TABLE attendance_daily
  ADD COLUMN off_site_request_id bigint REFERENCES off_site_work_requests(id) ON DELETE SET NULL;

CREATE INDEX attendance_daily_off_site_request_idx
  ON attendance_daily (off_site_request_id)
  WHERE off_site_request_id IS NOT NULL;
