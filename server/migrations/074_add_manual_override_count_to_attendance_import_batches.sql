-- How many punches HR corrected by hand before confirming an import.
--
-- The classifier's shift-window buffer (MATCH_BUFFER_MINUTES, 2 hours) covers
-- ordinary overnight shifts, but not OT that runs past it — the punch then
-- gets attributed to the wrong work-date or read as the wrong in/out until a
-- human fixes it in the preview screen. That correction is exactly the kind
-- of thing this table already exists to answer "what happened in this
-- import" about, so it gets a column rather than living only in
-- audit_log.detail.

ALTER TABLE attendance_import_batches
  ADD COLUMN manual_override_count integer NOT NULL DEFAULT 0;

ALTER TABLE attendance_import_batches
  ADD CONSTRAINT attendance_import_batches_manual_override_count
    CHECK (manual_override_count >= 0);
