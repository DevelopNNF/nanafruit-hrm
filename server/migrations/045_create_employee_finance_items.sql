-- Per-employee amounts for the finance items defined in master_finance_items
-- (041). One row per employee × item × period: "ค่าตำแหน่ง, 2,000 บาท, from
-- 2026-01-01 until further notice".
--
-- This is the half master_finance_items deliberately left out. The master is
-- the vocabulary; the amount belongs here because two people on ค่าตำแหน่ง
-- rarely get the same figure.
--
-- No item_type column: the type is master_finance_items.item_type, reached by
-- join. Storing a copy would let the two disagree, and the admin screen
-- presents type as something the system fills in from the chosen item rather
-- than something HR types.
--
--   Note for whoever builds payroll: that join is fine for "what applies
--   now", and wrong as a record of what was paid. If HR re-types an item in
--   the master, every past period computed from this join changes with it —
--   the same trap employment_details.shift_id fell into before
--   023_create_employee_shift_assignments.sql replaced it. The fix belongs in
--   the payslip table, which must snapshot item name, type and amount at the
--   moment a period is run, not in another column here.
--
-- amount is always positive; the sign is the item's type ('income' adds,
-- 'deduction' and 'tax' subtract). Allowing a negative here would make a
-- deduction enterable two different ways, and one of them subtracts twice.
--
-- effective_to IS NULL means "until further notice", same convention as
-- employee_shift_assignments.effective_to. There is no is_active column: the
-- date range already says whether a row applies, and a second switch that
-- says the same thing only raises the question of which one wins.
--
-- No DELETE route for now, by decision — a row entered by mistake is edited,
-- not removed. If that turns out to be too strict, adding DELETE later is a
-- route, not a migration.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE employee_finance_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id      bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  finance_item_id  bigint NOT NULL REFERENCES master_finance_items(id) ON DELETE RESTRICT,
  amount           numeric(12, 2) NOT NULL CHECK (amount > 0),
  effective_from   date NOT NULL,
  effective_to     date,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_finance_items_period_order CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  -- The same item must not apply to the same employee twice at once. Without
  -- this, ค่าตำแหน่ง at 1,000 for Jan–Jun and at 2,000 for Mar–Dec both match
  -- March and payroll quietly pays 3,000 — a typo that reads as a raise.
  --
  -- An EXCLUDE constraint rather than a check in the route, because the route
  -- version has a gap: two admins saving at the same moment each see a clear
  -- calendar and both commit. This is also why btree_gist is required above —
  -- gist alone cannot index the two bigint equality columns.
  --
  -- '[]' makes both ends inclusive, so a row ending 31 Jan and the next
  -- starting 1 Feb do not collide. A NULL upper bound is unbounded, which is
  -- exactly what "until further notice" has to mean here.
  CONSTRAINT employee_finance_items_no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    finance_item_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);

-- The list query behind the employee's finance tab. The gist index the
-- EXCLUDE constraint creates can answer this too, but not as cheaply as a
-- plain btree on the column actually filtered.
CREATE INDEX employee_finance_items_employee_idx
  ON employee_finance_items (employee_id, effective_from);
