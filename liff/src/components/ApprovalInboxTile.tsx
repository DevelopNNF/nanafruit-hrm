import { useEffect, useState } from 'react'
import { fetchPendingApprovals } from '../api/approvals'

type Props = {
  isSupervisor: boolean
  onNavigate: () => void
}

/** Home-screen entry point into the approval inbox. Renders nothing at all
 *  for the majority of employees who supervise no one — see
 *  LineSessionResponse.isSupervisor — rather than an always-present tile
 *  with a permanent empty state. The pending count is fetched only once
 *  isSupervisor is already known true, purely for the badge; a failed fetch
 *  just leaves the badge at 0 rather than surfacing an error banner here. */
export function ApprovalInboxTile({ isSupervisor, onNavigate }: Props) {
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    if (!isSupervisor) return
    const controller = new AbortController()
    fetchPendingApprovals(controller.signal)
      .then((body) => setPendingCount(body.pending.length))
      .catch(() => {
        if (controller.signal.aborted) return
      })
    return () => controller.abort()
  }, [isSupervisor])

  if (!isSupervisor) return null

  return (
    <button type="button" className="home-tile-approvals" onClick={onNavigate}>
      <span className={`home-tile-approvals-count ${pendingCount > 0 ? 'has-pending' : ''}`}>
        {pendingCount}
      </span>
      <span className="home-tile-approvals-text">
        <span className="home-tile-approvals-label">รออนุมัติจากฉัน</span>
        <span className="home-tile-approvals-hint">
          {pendingCount > 0 ? 'คำขอจากทีมที่รอคุณตัดสินใจ' : 'ไม่มีคำขอค้างในทีมของคุณ'}
        </span>
      </span>
      <span className="home-tile-approvals-arrow" aria-hidden="true">
        →
      </span>
    </button>
  )
}
