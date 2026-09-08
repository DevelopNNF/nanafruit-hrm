// Context and hook live apart from the provider component for the same Fast
// Refresh reason as auth/meContext.ts: a file that also exports a component
// can't be swapped without remounting the tree under it.

import { createContext, use } from 'react'
import type { DashboardPendingApprovalsSummaryResponse } from '@hrm/shared'

export type PendingApprovalsState =
  | { phase: 'loading' }
  | { phase: 'ok'; summary: DashboardPendingApprovalsSummaryResponse }
  | { phase: 'error'; message: string }

export type PendingApprovalsContextValue = {
  state: PendingApprovalsState
  /** Re-fetches the summary right away, outside the poll interval. Call this
   *  after an approve/reject (or similar decision) succeeds so the badge that
   *  led the admin here updates immediately instead of sitting stale until
   *  the next poll tick or a full page navigation. */
  refresh: () => void
}

export const PendingApprovalsContext = createContext<PendingApprovalsContextValue | null>(null)

function useContextValue(): PendingApprovalsContextValue {
  const value = use(PendingApprovalsContext)
  if (!value) throw new Error('usePendingApprovals() outside PendingApprovalsProvider')
  return value
}

/** Shared by AppLayout's nav badges and the dashboard's summary cards, so the
 *  two read one fetch instead of racing two independent ones. */
export function usePendingApprovals(): PendingApprovalsState {
  return useContextValue().state
}

export function useRefreshPendingApprovals(): () => void {
  return useContextValue().refresh
}
