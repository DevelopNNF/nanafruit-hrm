import { useEffect, useState } from 'react'
import type { HealthOk, HealthResponse } from '@hrm/shared'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; data: HealthOk }
  | { phase: 'error'; message: string }

export function HealthPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()

    async function check() {
      try {
        const res = await fetch('/api/health', { signal: controller.signal })
        const body = (await res.json()) as HealthResponse
        if (!res.ok || body.status === 'error') {
          throw new Error(
            body.status === 'error' ? body.message : `HTTP ${res.status}`,
          )
        }
        setState({ phase: 'ok', data: body })
      } catch (err) {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      }
    }

    void check()
    return () => controller.abort()
  }, [])

  return (
    <>
      <header className="page-head">
        <div>
          <h1>สถานะระบบ</h1>
          <p className="subtitle">connectivity check: admin → server → PostgreSQL</p>
        </div>
      </header>

      <div className={`card ${state.phase}`}>
        {state.phase === 'loading' && <p>Checking…</p>}

        {state.phase === 'ok' && (
          <>
            <p className="headline">All three layers connected</p>
            <dl>
              <dt>Database</dt>
              <dd>{state.data.database}</dd>
              <dt>Server time</dt>
              <dd>{new Date(state.data.serverTime).toLocaleString()}</dd>
            </dl>
          </>
        )}

        {state.phase === 'error' && (
          <>
            <p className="headline">Not connected</p>
            <p className="detail">{state.message}</p>
          </>
        )}
      </div>
    </>
  )
}
