-- Snapshots which off_site_work_requests row a clock event was validated
-- against, mirroring matched_location_id (010) for the ordinary geofence
-- case: matched_location_id and matched_off_site_request_id are the two
-- alternative "where this punch was allowed" answers a clock event can carry,
-- never both, and distance_meters (already on this table) applies to
-- whichever one matched.
--
-- ON DELETE RESTRICT for the same reason as matched_location_id: there is no
-- DELETE route for off_site_work_requests either, an approved request that
-- already validated a real punch is not something that should disappear out
-- from under it.

ALTER TABLE attendance_events
  ADD COLUMN matched_off_site_request_id bigint REFERENCES off_site_work_requests(id) ON DELETE RESTRICT;

ALTER TABLE attendance_events
  DROP CONSTRAINT attendance_events_location_match_pair;

ALTER TABLE attendance_events
  ADD CONSTRAINT attendance_events_location_match_pair CHECK (
    -- distance_meters is set exactly when exactly one of the two match
    -- columns is set.
    (distance_meters IS NULL) = (matched_location_id IS NULL AND matched_off_site_request_id IS NULL)
  ),
  ADD CONSTRAINT attendance_events_location_match_exclusive CHECK (
    NOT (matched_location_id IS NOT NULL AND matched_off_site_request_id IS NOT NULL)
  );

CREATE INDEX attendance_events_matched_off_site_request_idx
  ON attendance_events (matched_off_site_request_id);
