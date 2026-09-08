import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getPendingApprovalsSummary } from '../api/dashboard'
import {
  PendingApprovalsContext,
  type PendingApprovalsContextValue,
  type PendingApprovalsState,
} from './pendingApprovalsContext'

/** How often nav badges and the dashboard cards refresh in the background —
 *  frequent enough that approving something elsewhere clears a badge within
 *  a couple minutes, not so frequent it's a meaningful load on the summary
 *  endpoint's six count queries. An approve/reject on this device itself
 *  doesn't wait for this: it calls refresh() for an immediate update. */
const POLL_INTERVAL_MS = 90_000

/**
 * Fetches /api/dashboard/pending-approvals-summary once for the whole app —
 * mounted above AppLayout's Outlet so both the nav-bar badges (rendered on
 * every page) and the dashboard's own cards read the same state instead of
 * each firing their own request — refreshing it on an interval and whenever
 * a consumer calls refresh() (see useRefreshPendingApprovals), so an
 * approve/reject clears the badge that prompted it right away.
 */
export function PendingApprovalsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PendingApprovalsState>({ phase: 'loading' })
  // One controller for the provider's whole lifetime — refresh() re-runs the
  // same fetch on demand, it doesn't need its own cancellation scope.
  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    const controller = controllerRef.current
    if (!controller) return
    getPendingApprovalsSummary(controller.signal)
      .then((summary) => {
        if (!controller.signal.aborted) setState({ phase: 'ok', summary })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    load()
    const interval = setInterval(load, POLL_INTERVAL_MS)

    return () => {
      controller.abort()
      controllerRef.current = null
      clearInterval(interval)
    }
  }, [load])

  const value = useMemo<PendingApprovalsContextValue>(
    () => ({ state, refresh: load }),
    [state, load]
  )

  return <PendingApprovalsContext value={value}>{children}</PendingApprovalsContext>
}
