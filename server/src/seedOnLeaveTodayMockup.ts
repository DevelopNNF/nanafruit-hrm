// One-off dev-only script: creates a few approved leave requests covering
// today, so the dashboard's "ลาวันนี้" (on leave today) widget has something
// to show while previewing it. Every row this creates is tagged with
// MOCKUP_OID (as decided_by_oid / created_by_name) so
// removeOnLeaveTodayMockup.ts can find and delete exactly these rows and
// nothing else real HR data ever created.
//
// Picks the first active leave type and up to MOCK_COUNT active employees
// who don't already have a pending/approved request covering today — never
// touches an employee's real leave history.
//
// Usage (from server/):
//   npx tsx src/seedOnLeaveTodayMockup.ts

import 'dotenv/config'
import { pool, withTransaction } from './db.js'
import { MOCKUP_NAME, MOCKUP_OID } from './onLeaveTodayMockupConstants.js'

const MOCK_REASON = '[MOCKUP] ข้อมูลทดสอบสำหรับพรีวิวแดชบอร์ด — ลบได้'
const MOCK_COUNT = 3

/** 'Today' in Thailand, regardless of the server's own timezone — same
 *  helper as leaveRequests.ts's thailandToday. */
function thailandToday(): string {
  const bangkokNow = new Date(Date.now() + 7 * 60 * 60 * 1000)
  return bangkokNow.toISOString().slice(0, 10)
}

async function main(): Promise<void> {
  const today = thailandToday()
  const year = Number(today.slice(0, 4))

  const { rows: leaveTypeRows } = await pool.query<{ id: string; leave_name: string }>(
    `SELECT id, leave_name FROM master_leave_types WHERE is_active = true ORDER BY id LIMIT 1`
  )
  const leaveType = leaveTypeRows[0]
  if (!leaveType) throw new Error('no active leave type found — seed master_leave_types first')

  const { rows: employeeRows } = await pool.query<{
    id: string
    employee_code: string
    employee_name: string
  }>(
    `SELECT e.id, e.employee_code, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
     FROM employees e
     JOIN employment_details d ON d.employee_id = e.id
     WHERE d.status = 'Active'
       AND NOT EXISTS (
         SELECT 1 FROM leave_requests lr
         WHERE lr.employee_id = e.id AND lr.status IN ('pending', 'approved')
           AND lr.start_date <= $1 AND lr.end_date >= $1
       )
     ORDER BY e.id
     LIMIT $2`,
    [today, MOCK_COUNT]
  )
  if (employeeRows.length === 0) {
    throw new Error('no active employee free of an existing leave request today to use for mockup data')
  }

  console.log(
    `Seeding ${employeeRows.length} mockup leave request(s) for ${today}, leave type "${leaveType.leave_name}"`
  )

  for (const employee of employeeRows) {
    await withTransaction(async (client) => {
      const { rows: entryRows } = await client.query<{ id: string }>(
        `INSERT INTO leave_balance_entries
           (employee_id, leave_type_id, year, entry_type, amount_days, created_by_oid, created_by_name)
         VALUES ($1, $2, $3, 'usage', -1, $4, $5)
         RETURNING id`,
        [employee.id, leaveType.id, year, MOCKUP_OID, MOCKUP_NAME]
      )
      const balanceEntryId = entryRows[0]?.id
      if (!balanceEntryId) throw new Error('insert into leave_balance_entries returned no id')

      await client.query(
        `INSERT INTO leave_requests
           (employee_id, leave_type_id, start_date, end_date, total_days, reason, status,
            decided_by_oid, decided_by_name, decided_at, leave_balance_entry_id)
         VALUES ($1, $2, $3, $3, 1, $4, 'approved', $5, $6, now(), $7)`,
        [employee.id, leaveType.id, today, MOCK_REASON, MOCKUP_OID, MOCKUP_NAME, balanceEntryId]
      )
    })
    console.log(`  ${employee.employee_code} ${employee.employee_name} — OK`)
  }

  console.log('Done. Run `npx tsx src/removeOnLeaveTodayMockup.ts` to remove this mockup data afterward.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    void pool.end()
  })
