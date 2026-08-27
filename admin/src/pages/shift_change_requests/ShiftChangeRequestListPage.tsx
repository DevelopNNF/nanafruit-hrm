import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ShiftChangeRequestListItem, ShiftChangeRequestStage, ShiftChangeRequestStatus } from '@hrm/shared'
import { listShiftChangeRequests, listShiftChangeRequestsPendingApproval } from '../../api/shiftChangeRequests'
import { Pagination } from '../../components/Pagination'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { alert, alertDetail, alertTitle, badge, cardEmpty, eyebrow, muted, pageHead, subtitle } from '../../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; requests: ShiftChangeRequestListItem[]; total: number }
  | { phase: 'error'; message: string }

/** Matches the server's own default in shiftChangeRequestQueries.ts. */
const DEFAULT_PAGE_SIZE = 50

// 'mine' is not a ShiftChangeRequestStatus — it's the caller's own supervisor
// inbox, fetched from a different endpoint (see the effect below). It stays
// unpaginated — see LeaveRequestListPage's comment on the same tab.
type TabValue = ShiftChangeRequestStatus | 'all' | 'mine'

const TABS: { value: TabValue; label: string }[] = [
  { value: 'mine', label: 'รอฉันอนุมัติ' },
  { value: 'pending', label: 'รอดำเนินการ' },
  { value: 'approved', label: 'อนุมัติแล้ว' },
  { value: 'rejected', label: 'ปฏิเสธแล้ว' },
  { value: 'cancelled', label: 'ยกเลิกแล้ว' },
  { value: 'all', label: 'ทั้งหมด' },
]

const STATUS_LABEL: Record<ShiftChangeRequestStatus, string> = {
  pending: 'รอดำเนินการ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ปฏิเสธแล้ว',
  cancelled: 'ยกเลิกแล้ว',
}

const STAGE_LABEL: Record<ShiftChangeRequestStage, string> = {
  supervisor: 'รอหัวหน้างาน',
  hr: 'รอ HR/Admin',
}

function statusBadgeTone(status: ShiftChangeRequestStatus): 'pending' | 'active' | 'danger' | 'inactive' {
  if (status === 'approved') return 'active'
  if (status === 'rejected') return 'danger'
  if (status === 'cancelled') return 'inactive'
  return 'pending'
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function ShiftChangeRequestListPage() {
  const [tab, setTab] = useState<TabValue>('pending')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [state, setState] = useState<State>({ phase: 'loading' })
  // True while a tab/page/page-size request is in flight — used to disable
  // <Pagination> rather than resetting `state` to 'loading'.
  const [fetching, setFetching] = useState(true)
  const navigate = useNavigate()

  // No setState({ phase: 'loading' }) at the top: switching tabs leaves the
  // old table in place until the new one is ready, rather than flashing
  // blank — same reasoning as LeaveRequestListPage's filter effect.
  useEffect(() => {
    const controller = new AbortController()

    const fetchRequests =
      tab === 'mine'
        ? listShiftChangeRequestsPendingApproval(controller.signal).then((requests) => ({
            requests,
            total: requests.length,
          }))
        : listShiftChangeRequests(tab === 'all' ? undefined : tab, { page, pageSize }, controller.signal)

    fetchRequests
      .then((body) => {
        setState({ phase: 'ok', requests: body.requests, total: body.total })
        setFetching(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
        setFetching(false)
      })

    return () => controller.abort()
  }, [tab, page, pageSize])

  function handleTabChange(next: string) {
    setFetching(true)
    setTab(next as TabValue)
    setPage(1)
  }

  function goToPage(next: number) {
    setFetching(true)
    setPage(next)
  }

  function handlePageSizeChange(next: number) {
    setFetching(true)
    setPageSize(next)
    setPage(1)
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Shift</p>
          <h1>คำขอเปลี่ยนกะ</h1>
          <p className={subtitle}>คำขอเปลี่ยนกะจากพนักงาน รออนุมัติหรือปฏิเสธ</p>
        </div>
      </header>

      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={tab}>
          {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

          {state.phase === 'error' && (
            <div className={alert('danger')}>
              <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
              <p className={alertDetail}>{state.message}</p>
            </div>
          )}

          {state.phase === 'ok' && state.requests.length === 0 && (
            <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบคำขอในหมวดนี้</p>
              <p className={muted}>ลองเปลี่ยนแท็บด้านบน</p>
            </div>
          )}

          {state.phase === 'ok' && state.requests.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
                <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">{state.total} รายการ</p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                  <thead>
                    <tr>
                      {['#', 'รหัสพนักงาน', 'ชื่อพนักงาน', 'วันที่ขอเปลี่ยนกะ', 'กะเดิม', 'กะใหม่', 'เหตุผล', 'สถานะ', 'ขั้นตอน'].map(
                        (h) => (
                          <th
                            key={h}
                            className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap"
                          >
                            {h}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {state.requests.map((request, index) => (
                      <tr
                        key={request.id}
                        onClick={() => void navigate(`/shift-change-requests/${request.id}`)}
                        className="cursor-pointer hover:bg-slate-50"
                      >
                        <td className="w-12 border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500">
                          {index + 1}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900">
                          {request.employeeCode}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                          {request.employeeName}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                          {formatDate(request.requestedDate)}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                          {request.currentShiftName ?? '—'}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                          {request.newShiftName}
                        </td>
                        <td className="max-w-64 truncate border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                          {request.reason}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                          <span className={badge(statusBadgeTone(request.status))}>{STATUS_LABEL[request.status]}</span>
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                          {request.status === 'pending' && request.currentStage
                            ? STAGE_LABEL[request.currentStage]
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {tab !== 'mine' && (
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  totalItems={state.total}
                  onPageChange={goToPage}
                  onPageSizeChange={handlePageSizeChange}
                  disabled={fetching}
                />
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </>
  )
}
