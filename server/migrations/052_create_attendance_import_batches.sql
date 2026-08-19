-- One row per accepted upload of a fingerprint terminal's attendance export.
--
-- attendance_events is append-only and carries no notion of "where did this
-- come from beyond the channel", so without this table a punch imported from a
-- spreadsheet is indistinguishable from any other — and the question HR will
-- actually ask ("which file did the 3rd of August come from, and who loaded
-- it?") has no answer. audit_log records that an import happened and by whom,
-- but its detail column is deliberately a loose bag; the counts below are worth
-- columns because the import history screen filters and sums on them.
--
-- Deliberately NOT an undo ledger. There is no route that deletes a batch or
-- its events: attendance_events has no delete path at all, and a wrong import
-- is corrected the same way every other wrong punch is — by a time correction.
-- The FK from attendance_events is therefore ON DELETE RESTRICT, matching the
-- other snapshot references in that table.
--
-- range_from/range_to are the window the FILE declared (its C3 header), not
-- the span of punches actually written: a file can cover ten days and contain
-- punches on seven of them, and "what period did HR mean to load" is the more
-- useful question afterwards. generated_on is the terminal's own export date,
-- nullable because it is a nicety the sheet may not carry.
--
-- unmatched_codes keeps the fingerprint codes in the file that matched no
-- employee. They are the actionable part of a partial import — someone has to
-- go fill in a รหัสลายนิ้วมือ and load the file again — so they are stored
-- rather than merely counted.

CREATE TABLE attendance_import_batches (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_name               text NOT NULL,
  file_size_bytes         integer NOT NULL,
  range_from              date NOT NULL,
  range_to                date NOT NULL,
  generated_on            date,
  -- Employees actually written to, i.e. matched codes with at least one new
  -- punch. Not the number of ID blocks in the file.
  employee_count          integer NOT NULL,
  event_count             integer NOT NULL,
  skipped_duplicate_count integer NOT NULL,
  unmatched_codes         text[] NOT NULL DEFAULT '{}',
  -- Entra object id + display name of whoever uploaded it, snapshotted the
  -- same way time_correction_requests snapshots its approver: the name is for
  -- display and may go stale, the oid is the identifier.
  imported_by_oid         text NOT NULL,
  imported_by_name        text,
  imported_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_import_batches_range CHECK (range_to >= range_from),
  CONSTRAINT attendance_import_batches_counts CHECK (
    employee_count >= 0 AND event_count >= 0 AND skipped_duplicate_count >= 0
  )
);

-- The history screen's only ordering: newest upload first.
CREATE INDEX attendance_import_batches_imported_at_idx
  ON attendance_import_batches (imported_at DESC);
