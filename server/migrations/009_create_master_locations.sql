-- Location Master (พิกัดอนุญาตให้ลงเวลา), for attendance geofencing.
--
-- A flat table like master_jobs: no unique constraint on location_name,
-- matching job_title — a duplicate name is a data-entry nuisance for admin to
-- notice, not a state the database needs to forbid.
--
-- radius_meters is the allowed distance from (latitude, longitude) a clock
-- event's own coordinates must fall within to count as "at this location" —
-- see the Haversine check in server/src/geo.ts. A basic circle, not a
-- polygon: good enough for a single office/site, and what was asked for.
--
-- No soft-delete column beyond is_active and no DELETE route: retiring a
-- location is done by turning is_active off, matching master_jobs and
-- master_shifts. Write access is Admin-only (not HR) — narrower than
-- Job/Shift, since a wrong radius here is a security control, not a
-- scheduling detail.

CREATE TABLE master_locations (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  location_name   text NOT NULL,
  latitude        numeric(9, 6) NOT NULL,
  longitude       numeric(9, 6) NOT NULL,
  radius_meters   numeric(8, 2) NOT NULL CHECK (radius_meters > 0),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
