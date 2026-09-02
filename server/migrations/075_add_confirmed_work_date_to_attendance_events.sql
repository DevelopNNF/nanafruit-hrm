-- Lets a human-reviewed correction pin which work-date a punch belongs to,
-- bypassing the buffer-based guesswork attendanceMatchingQueries.ts otherwise
-- has to do from event_time alone.
--
-- shift_id already snapshots something at insert time, but attendanceMatchingQueries.ts
-- deliberately never trusts it (see that file's module comment) — it is
-- stamped automatically, with no human having looked at it. This column is
-- the opposite: it is set ONLY when a person explicitly confirmed the
-- work-date, currently just the attendance-import punch editor overriding
-- the classifier's own reading. That review is what earns it the matcher's
-- trust directly, with no buffer check at all — the whole point is covering
-- OT that ran long enough to fall outside MATCH_BUFFER_MINUTES, which by
-- definition the buffer can never be widened enough to catch on its own.
--
-- Null for every ordinary event — LIFF check-ins, unedited import punches,
-- time corrections. Nothing about existing behavior changes until a row
-- actually has this set.

ALTER TABLE attendance_events
  ADD COLUMN confirmed_work_date date;
