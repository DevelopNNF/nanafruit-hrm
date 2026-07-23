-- Snapshots which master_locations row a clock event was validated against,
-- mirroring attendance_events.shift_id: the geofence check that ran at
-- clock time is what should be visible on the row forever after, not a live
-- re-check against whatever master_locations looks like now (a location's
-- radius or position can change later, or the row can be deactivated).
--
-- Both columns are nullable together: null exactly when the clock event went
-- through while zero locations were active (geofencing not yet configured,
-- so nothing was checked against). Once at least one location is active,
-- every new event either matches one (both columns set) or is rejected
-- before insert — so a non-null distance_meters always has a matching
-- matched_location_id, and a row from before geofencing existed has neither.
--
-- ON DELETE RESTRICT for the same reason as shift_id: there is no DELETE
-- route for master_locations (is_active is the retirement mechanism), so this
-- only matters if a row is removed by hand.

ALTER TABLE attendance_events
  ADD COLUMN matched_location_id bigint REFERENCES master_locations(id) ON DELETE RESTRICT,
  ADD COLUMN distance_meters numeric(8, 2),
  ADD CONSTRAINT attendance_events_location_match_pair CHECK (
    (matched_location_id IS NULL) = (distance_meters IS NULL)
  );

CREATE INDEX attendance_events_matched_location_idx
  ON attendance_events (matched_location_id);
