-- Default annual entitlement for a leave type, used as the suggested amount
-- when HR issues a year's grant (see leave_balance_entries, migration 020
-- and the bulk-grant route). Nullable, not a CHECK-enforced default: a type
-- with no banked entitlement (e.g. ลาไม่รับค่าจ้าง, ลาบวช) simply never gets
-- a 'grant' entry, and null says that plainly rather than 0 (which would
-- read as "entitled to zero days" — a different claim).
--
-- Deliberately a flat number, not a tenure-based tier table: this is the
-- amount used *today* by the bulk-grant action, not a promise about how it
-- will always be computed. Switching to tenure tiers later only changes what
-- feeds a 'grant' entry's amount_days at the moment it's created — past
-- entries are historical fact and need no migration when that happens.

ALTER TABLE master_leave_types
  ADD COLUMN default_days_per_year numeric(5,2);
