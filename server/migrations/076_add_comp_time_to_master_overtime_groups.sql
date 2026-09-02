-- Lets a group of master_overtime_groups optionally offer OT-to-comp-time-off
-- conversion (วันหยุดสะสม) as an alternative to always paying OT as money.
-- Same flat-column shape as the five existing rate_* columns (see that
-- table's own comment): a fixed, small set of config values, not a list.
--
-- comp_time_enabled gates a second, independent set of five rate
-- multipliers (comp_rate_*) that convert OT minutes into accrued comp-time
-- minutes, e.g. 4 hours OT at comp_rate 1.5 -> 6 hours accrued. These are
-- deliberately separate from rate_* (the money rates): a group can have
-- comp-time enabled and still pay some OT as money per-request (see
-- overtime_requests.comp_time_requested, added later), so both rate sets
-- must be available at once.
--
-- comp_annual_cap_* caps how much a single employee can accrue via this
-- group per calendar year (not the standing balance, which resets itself
-- every January 1st by construction of how the ledger's balance query is
-- scoped — see overtime_comp_time_entries). Stored in minutes internally;
-- the admin UI collects and displays this as whole hours, since HR's
-- original wording ("days") doesn't map to a fixed number of minutes across
-- employees with different shift lengths.
--
-- comp_rounding_minutes uses the same closed set as rounding_minutes, but
-- rounds to the NEAREST step rather than down — the money-side rounding
-- described in this table's original comment discards partial minutes so
-- nobody is paid for time not worked, but an accrual has no such asymmetry
-- to protect, so nearest is the natural default here.

ALTER TABLE master_overtime_groups
  ADD COLUMN comp_time_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN comp_rate_ot_workday     numeric(4, 2),
  ADD COLUMN comp_rate_normal_dayoff  numeric(4, 2),
  ADD COLUMN comp_rate_ot_dayoff      numeric(4, 2),
  ADD COLUMN comp_rate_normal_holiday numeric(4, 2),
  ADD COLUMN comp_rate_ot_holiday     numeric(4, 2),
  ADD COLUMN comp_annual_cap_enabled  boolean NOT NULL DEFAULT false,
  ADD COLUMN comp_annual_cap_minutes  integer,
  ADD COLUMN comp_rounding_minutes    integer NOT NULL DEFAULT 0
    CHECK (comp_rounding_minutes IN (0, 15, 30, 60));

ALTER TABLE master_overtime_groups
  ADD CONSTRAINT master_overtime_groups_comp_rates_required CHECK (
    NOT comp_time_enabled OR (
      comp_rate_ot_workday     IS NOT NULL AND comp_rate_ot_workday     > 0 AND
      comp_rate_normal_dayoff  IS NOT NULL AND comp_rate_normal_dayoff  > 0 AND
      comp_rate_ot_dayoff      IS NOT NULL AND comp_rate_ot_dayoff      > 0 AND
      comp_rate_normal_holiday IS NOT NULL AND comp_rate_normal_holiday > 0 AND
      comp_rate_ot_holiday     IS NOT NULL AND comp_rate_ot_holiday     > 0
    )
  ),
  ADD CONSTRAINT master_overtime_groups_comp_cap_requires_enabled CHECK (
    comp_time_enabled OR NOT comp_annual_cap_enabled
  ),
  ADD CONSTRAINT master_overtime_groups_comp_cap_value_required CHECK (
    NOT comp_annual_cap_enabled OR (comp_annual_cap_minutes IS NOT NULL AND comp_annual_cap_minutes > 0)
  ),
  ADD CONSTRAINT master_overtime_groups_comp_cap_null_when_disabled CHECK (
    comp_annual_cap_enabled OR comp_annual_cap_minutes IS NULL
  );
