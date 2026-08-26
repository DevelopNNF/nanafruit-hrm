-- One row per outbound notification attempt (LINE push or Power Automate
-- email), win or lose. Fire-and-forget is the whole point of this table:
-- notifications never retry and never block the request that triggered
-- them, so this is the only place a failed or skipped send is visible at
-- all — see server/src/notifications/dispatch.ts.
--
-- Append-only, same as audit_log and for the same reason: nothing in the
-- application updates or deletes from here.

CREATE TABLE notification_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- 'leave_request.created', 'overtime_request.rejected', and so on — one
  -- per RequestActionEvent's kind, paired with its resource.
  event_type    text NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('line', 'email')),
  -- A line_user_id, or a comma-joined email list. Null when status is
  -- 'skipped' because no recipient could be resolved at all.
  recipient     text,
  status        text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error_message text,
  detail        jsonb
);

-- The two questions this table gets asked: "what happened lately" and
-- "what's been failing" — the latter as a partial index, since almost every
-- row is expected to be a plain 'sent'.
CREATE INDEX notification_log_created_at_idx ON notification_log (created_at DESC);
CREATE INDEX notification_log_status_idx ON notification_log (status, created_at DESC) WHERE status <> 'sent';
