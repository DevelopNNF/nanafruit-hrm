// Deletes exactly what seedOnLeaveTodayMockup.ts created — every
// leave_requests / leave_balance_entries row tagged with MOCKUP_OID — and
// nothing else. Leave requests are deleted before their balance entries
// deliberately: leave_balance_entry_id has ON DELETE SET NULL, and a
// leave_requests row's decision_consistency CHECK requires an 'approved' row
// to keep a non-null leave_balance_entry_id, so nulling it out from under a
// row that still exists would fail that check — deleting the whole row first
// sidesteps it.
//
// Usage (from server/):
//   npx tsx src/removeOnLeaveTodayMockup.ts

import 'dotenv/config'
import { pool } from './db.js'
import { MOCKUP_OID } from './seedOnLeaveTodayMockup.js'

async function main(): Promise<void> {
  const { rowCount: requestsDeleted } = await pool.query(
    `DELETE FROM leave_requests WHERE decided_by_oid = $1`,
    [MOCKUP_OID]
  )
  const { rowCount: entriesDeleted } = await pool.query(
    `DELETE FROM leave_balance_entries WHERE created_by_oid = $1`,
    [MOCKUP_OID]
  )

  console.log(
    `Removed ${requestsDeleted ?? 0} mockup leave request(s) and ${entriesDeleted ?? 0} mockup leave balance entr(y/ies).`
  )
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    void pool.end()
  })
