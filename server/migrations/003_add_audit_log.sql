-- Who changed what.
--
-- employees.updated_at already says *when* a row last changed, but not by whom,
-- and nothing at all survives a delete. This is the record that outlives the row.
--
-- Every entry is written in the same transaction as the change it describes, so
-- a committed change without its audit entry is not a state this table can reach.
--
-- Append-only by intent: nothing in the application updates or deletes from here.
-- That is not enforced with grants because the API connects as the owner; if that
-- ever matters, the fix is a role that holds INSERT and SELECT and nothing else.

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- Who. Mirrors the two arms of AuthUser in shared/src/index.ts.
  actor_kind  text NOT NULL CHECK (actor_kind IN ('admin', 'employee')),
  -- Entra oid for an admin, employee id for an employee. Text because those are
  -- two different kinds of identifier and this column holds either.
  actor_id    text NOT NULL,
  -- upn at the time of the action, for admins. Kept as written rather than
  -- resolved later: people get renamed, and the log should read as it happened.
  actor_label text,

  -- What. 'employee.create', 'employee.line_linked', and so on.
  action      text NOT NULL,
  -- Which row it happened to. No foreign key: the whole point is to still be
  -- here after that row is gone.
  entity_id   text,

  -- Anything worth keeping that is not a column — the employee code on a delete,
  -- say. Deliberately not a full before/after diff: that is a bigger feature and
  -- a bigger pile of personal data to hold.
  detail      jsonb
);

-- The two questions this table gets asked: "what happened lately" and
-- "what happened to this employee".
CREATE INDEX audit_log_occurred_at_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_entity_id_idx ON audit_log (entity_id, occurred_at DESC);
