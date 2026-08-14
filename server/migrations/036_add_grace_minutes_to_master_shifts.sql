-- Grace period before a clock event counts as late/early, in minutes. Feeds
-- the not-yet-built attendance-matching logic (see attendanceMatchingQueries.ts) —
-- kept per-shift, not global, since a factory shift and an office shift can
-- reasonably tolerate different amounts of slack.

ALTER TABLE master_shifts
  ADD COLUMN late_grace_minutes        smallint NOT NULL DEFAULT 0,
  ADD COLUMN early_leave_grace_minutes smallint NOT NULL DEFAULT 0;

ALTER TABLE master_shifts ADD CONSTRAINT master_shifts_grace_minutes_range
  CHECK (late_grace_minutes >= 0 AND early_leave_grace_minutes >= 0);
