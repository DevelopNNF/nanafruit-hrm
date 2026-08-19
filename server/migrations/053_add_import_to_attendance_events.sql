-- The third channel a punch can arrive through: a fingerprint terminal's
-- spreadsheet export, loaded by HR after the fact. 'liff_gps' was the only
-- value while attendance had one channel, 012 added 'admin_correction', and
-- this adds the import.
--
-- Worth its own source value rather than reusing 'admin_correction': the two
-- differ in what they promise. A correction is one punch an approver vouched
-- for individually; an import is a bulk transcription of what a machine
-- recorded, which nobody has eyeballed. The admin list shows them differently
-- for that reason.

ALTER TABLE attendance_events DROP CONSTRAINT attendance_events_source_check;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_source_check
  CHECK (source IN ('liff_gps', 'admin_correction', 'fingerprint_import'));

-- Which upload a row came from. Null for every punch that arrived any other
-- way, so this doubles as the "was this imported" flag alongside source.
-- RESTRICT rather than SET NULL: unlike the derived pointers in
-- attendance_daily, this is provenance — a batch row must not be removable out
-- from under the events that cite it (and nothing deletes batches anyway).
ALTER TABLE attendance_events
  ADD COLUMN import_batch_id bigint
    REFERENCES attendance_import_batches(id) ON DELETE RESTRICT,
  ADD CONSTRAINT attendance_events_import_batch_pair CHECK (
    (import_batch_id IS NULL) OR (source = 'fingerprint_import')
  );

CREATE INDEX attendance_events_import_batch_idx
  ON attendance_events (import_batch_id);

-- Re-importing an overlapping period is not merely allowed, it is the
-- documented way to close an overnight shift whose check-out landed in the
-- NEXT export (the last night of every file is otherwise left open). That
-- makes "the same punch arriving twice" the normal case rather than the
-- exceptional one, so it is settled in the database instead of relying on the
-- route's pre-check winning a race with a second upload.
--
-- Partial, covering imports only: two check-ins at the same instant from
-- different channels is a different situation (a real duplicate the route
-- filters, not a constraint violation), and a unique index over every source
-- would turn it into a 500.
CREATE UNIQUE INDEX attendance_events_import_dedup_key
  ON attendance_events (employee_id, event_time, event_type)
  WHERE source = 'fingerprint_import';
