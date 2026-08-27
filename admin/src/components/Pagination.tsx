// A count + page-size selector + prev/next bar for a list paged server-side
// (LIMIT/OFFSET), as opposed to a list that just truncates past some row cap.
// Shared across report/list pages so each one only owns its own page/pageSize
// state and a fetch effect — see AttendanceReport.tsx for the first user.

import { button } from '../styles'

export type PaginationProps = {
  /** 1-based. */
  page: number
  pageSize: number
  /** Total rows matching the current filter, across all pages. */
  totalItems: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  pageSizeOptions?: readonly number[]
  /** Disables every control — while a page/page-size change is in flight. */
  disabled?: boolean
}

const DEFAULT_PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const

export function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  disabled,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
        {totalItems} รายการ (หน้า {page} จาก {totalPages})
      </p>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-[0.775rem] whitespace-nowrap text-slate-500">
          <span>แสดงต่อหน้า</span>
          <select
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[0.775rem] text-slate-900 hover:enabled:border-slate-500"
            value={pageSize}
            disabled={disabled}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className={button('default')}
            disabled={disabled || page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            ก่อนหน้า
          </button>
          <button
            type="button"
            className={button('default')}
            disabled={disabled || page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          >
            ถัดไป
          </button>
        </div>
      </div>
    </div>
  )
}
