import { useEffect, useState } from 'react'
import type { HealthOk, HealthResponse } from '@hrm/shared'
import { alert, alertDetail, alertTitle, card, cardHead, eyebrow, fluidGrid, pageHead, spec, specDd, specDt, subtitle } from '../styles'

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
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>ระบบ</p>
          <h1>สถานะระบบ</h1>
          <p className={subtitle}>connectivity check: admin → server → PostgreSQL</p>
        </div>
      </header>

      {state.phase === 'loading' && (
        <div className={alert()}>
          <p className={alertTitle()}>กำลังตรวจสอบ…</p>
        </div>
      )}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>เชื่อมต่อไม่ได้</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && (
        <>
          <div className={alert('ok')}>
            <p className={alertTitle()}>เชื่อมต่อครบทั้งสามชั้น</p>
          </div>

          <div className={fluidGrid('20rem')}>
            <section className={card}>
              <header className={cardHead}>
                <h2>รายละเอียด</h2>
              </header>
              <dl className={spec}>
                <dt className={specDt}>Database</dt>
                <dd className={specDd}>{state.data.database}</dd>
                <dt className={specDt}>Server time</dt>
                <dd className={specDd}>
                  {new Date(state.data.serverTime).toLocaleString('th-TH')}
                </dd>
              </dl>
            </section>
          </div>
        </>
      )}
    </>
  )
}
