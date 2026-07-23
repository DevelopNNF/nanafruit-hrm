-- Widen attendance_events.source to allow the event an approved time
-- correction request inserts. 'liff_gps' was the only value while attendance
-- had one channel; time_correction_requests is the second.

ALTER TABLE attendance_events DROP CONSTRAINT attendance_events_source_check;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_source_check
  CHECK (source IN ('liff_gps', 'admin_correction'));
