// Reading holidays out of master_holidays. A single flat table with no join
// — group_name isn't selected here because every route reads holidays
// scoped to one already-known group (see routes/holidays.ts), so there is
// never a caller needing it joined in.
//
// No findHolidayById: nothing fetches a single holiday in isolation — the
// list within a group is what every caller (and the admin form) actually
// wants, so routes/holidays.ts queries that directly.

import type { Holiday } from '@hrm/shared'

export type HolidayRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  group_id: string
  holiday_name: string
  holiday_date: string // 'YYYY-MM-DD' — see the DATE type parser in db.ts
}

export const SELECT_HOLIDAY = `
  SELECT id, group_id, holiday_name, holiday_date
  FROM master_holidays
`

export function rowToHoliday(row: HolidayRow): Holiday {
  return {
    id: Number(row.id),
    groupId: Number(row.group_id),
    holidayName: row.holiday_name,
    holidayDate: row.holiday_date,
  }
}
