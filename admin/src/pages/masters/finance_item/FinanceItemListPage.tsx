import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { FINANCE_ITEM_TYPES, type FinanceItem, type FinanceItemType } from '@hrm/shared'
import { listFinanceItems, updateFinanceItem } from '../../../api/financeItems'
import { useCanWrite } from '../../../auth/meContext'
import { notify } from '../../../notifications/notify'
import {
  FINANCE_ITEM_TYPE_LABELS,
  FINANCE_ITEM_TYPE_TONE,
} from '../../../components/financeItemLabels'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  cardEmpty,
  eyebrow,
  muted,
  pageHead,
  subtitle,
} from '../../../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; financeItems: FinanceItem[] }
  | { phase: 'error'; message: string }

type TypeFilter = FinanceItemType | 'all'

function haystack(item: FinanceItem): string {
  return [item.itemCode, item.itemName, item.description ?? ''].join(' ').toLowerCase()
}

export function FinanceItemListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  useEffect(() => {
    const controller = new AbortController()

    listFinanceItems(controller.signal)
      .then((financeItems) => setState({ phase: 'ok', financeItems }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [])

  // Unlike the other master lists this filters on two things, because the list
  // grows past what a text search alone stays usable on — every allowance and
  // every deduction the company has ever paid ends up here.
  const visible = useMemo(() => {
    if (state.phase !== 'ok') return []
    const needle = query.trim().toLowerCase()
    return state.financeItems.filter((item) => {
      if (typeFilter !== 'all' && item.itemType !== typeFilter) return false
      return needle ? haystack(item).includes(needle) : true
    })
  }, [state, query, typeFilter])

  // No delete route: turning an item off is the entire lifecycle a retired
  // item has, same as jobs/shifts/locations/leave types/overtime groups.
  async function toggleActive(item: FinanceItem) {
    if (state.phase !== 'ok') return
    setTogglingId(item.id)
    try {
      const updated = await updateFinanceItem(item.id, { ...item, isActive: !item.isActive })
      setState({
        phase: 'ok',
        financeItems: state.financeItems.map((i) => (i.id === updated.id ? updated : i)),
      })
      notify.success(`${item.itemName} ${updated.isActive ? 'เปิด' : 'ปิด'}ใช้งานแล้ว`)
    } catch (err) {
      notify.error('บันทึกไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setTogglingId(null)
    }
  }

  const filtering = query.trim() !== '' || typeFilter !== 'all'

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Master Data</p>
          <h1>รายการทางการเงิน (Finance Item)</h1>
          <p className={subtitle}>รายรับ รายจ่าย และภาษี ที่นำไปตั้งค่ายอดเงินรายบุคคล</p>
        </div>
        {canWrite && (
          <Link className={button('primary')} to="/master/finance-items/new">
            <Plus size={16} />
            เพิ่มรายการทางการเงิน
          </Link>
        )}
      </header>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && state.financeItems.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีรายการทางการเงินในระบบ</p>
          <p className={muted}>
            {canWrite ? 'กด “เพิ่มรายการทางการเงิน” เพื่อเริ่มต้น' : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.financeItems.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
              <div className="relative flex max-w-88 min-w-0 flex-1 items-center">
                <Search size={15} className="pointer-events-none absolute left-2.5 text-slate-500" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="ค้นหารหัสหรือชื่อรายการ"
                  aria-label="ค้นหารายการทางการเงิน"
                  className="w-full rounded-md border border-slate-200 bg-white py-2 pr-3 pl-9 text-[0.825rem] text-slate-900 placeholder:text-slate-500"
                />
              </div>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
                aria-label="กรองตามประเภท"
                className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[0.825rem] text-slate-900"
              >
                <option value="all">ทุกประเภท</option>
                {FINANCE_ITEM_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {FINANCE_ITEM_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {filtering
                ? `พบ ${visible.length} จาก ${state.financeItems.length} รายการ`
                : `ทั้งหมด ${state.financeItems.length} รายการ`}
            </p>
          </div>

          {visible.length === 0 ? (
            <div className={cardEmpty}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบรายการที่ตรงกับเงื่อนไข</p>
              <p className={muted}>ลองใช้คำอื่น เปลี่ยนประเภท หรือล้างช่องค้นหา</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['#', 'รหัส', 'ชื่อรายการ', 'ประเภท', 'หมายเหตุ', 'เปิดใช้งาน'].map((h) => (
                      <th
                        key={h}
                        className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item, index) => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td
                        onClick={() => void navigate(`/master/finance-items/${item.id}`)}
                        className="w-12 cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500"
                      >
                        {index + 1}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/finance-items/${item.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-mono text-[0.775rem] text-slate-600"
                      >
                        {item.itemCode}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/finance-items/${item.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900"
                      >
                        {item.itemName}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                        <span className={badge(FINANCE_ITEM_TYPE_TONE[item.itemType])}>
                          {FINANCE_ITEM_TYPE_LABELS[item.itemType]}
                        </span>
                      </td>
                      <td className="max-w-80 border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                        {item.description ?? <span className="text-slate-400">—</span>}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                        <button
                          type="button"
                          disabled={!canWrite || togglingId === item.id}
                          onClick={() => void toggleActive(item)}
                          title={canWrite ? 'คลิกเพื่อเปิด/ปิดใช้งาน' : undefined}
                          className={`${badge(item.isActive ? 'active' : 'inactive')} disabled:opacity-60 ${
                            canWrite ? 'cursor-pointer' : 'cursor-default'
                          }`}
                        >
                          {item.isActive ? 'Active' : 'Inactive'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  )
}
