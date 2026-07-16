import { useEffect, useState } from 'react'
import liff from '@line/liff'
import type { HealthOk, HealthResponse } from '@hrm/shared'
import './App.css'

type Profile = {
  displayName: string
  pictureUrl?: string
}

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; data: HealthOk }
  | { phase: 'error'; message: string }

function App() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    // Display only. Anything the server is asked to trust has to come from
    // liff.getIDToken() and be verified against LINE server-side — a client can
    // claim any profile it likes, so this name is decoration, not identity.
    liff.getProfile().then(
      (p) => setProfile({ displayName: p.displayName, pictureUrl: p.pictureUrl }),
      () => {
        // Decoration failing to load is not worth surfacing.
      },
    )
  }, [])

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
    <main className="app">
      {profile && (
        <header className="profile">
          {profile.pictureUrl && (
            <img src={profile.pictureUrl} alt="" width={44} height={44} />
          )}
          <div>
            <p className="greeting">สวัสดี</p>
            <p className="name">{profile.displayName}</p>
          </div>
        </header>
      )}

      <h1>HRM</h1>
      <p className="subtitle">LIFF · สำหรับพนักงานและหัวหน้างาน</p>

      <div className={`card ${state.phase}`}>
        {state.phase === 'loading' && <p>กำลังตรวจสอบ…</p>}

        {state.phase === 'ok' && (
          <>
            <p className="headline">เชื่อมต่อครบทุกชั้นแล้ว</p>
            <dl>
              <dt>Database</dt>
              <dd>{state.data.database}</dd>
              <dt>Server time</dt>
              <dd>{new Date(state.data.serverTime).toLocaleString('th-TH')}</dd>
            </dl>
          </>
        )}

        {state.phase === 'error' && (
          <>
            <p className="headline">เชื่อมต่อไม่สำเร็จ</p>
            <p className="detail">{state.message}</p>
          </>
        )}
      </div>
    </main>
  )
}

export default App
