import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import liff from '@line/liff'
import './index.css'
import App from './App.tsx'
import BootFailure from './BootFailure.tsx'
import { startSession } from './api/auth.ts'

const root = createRoot(document.getElementById('root')!)

// liff.init() must resolve before any component touches the SDK, so the app is
// rendered from inside boot() rather than at module scope.
async function boot() {
  const liffId = import.meta.env.VITE_LIFF_ID
  if (!liffId) {
    throw new Error('VITE_LIFF_ID is not set — copy liff/.env.example to liff/.env')
  }

  await liff.init({ liffId })

  // Inside the LINE app this is always true. It only matters when the page is
  // opened in an external browser, where login() redirects to LINE and comes
  // back here — so nothing below it runs on that pass.
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: window.location.href })
    return
  }

  const idToken = liff.getIDToken()
  if (!idToken) {
    throw new Error(
      'LINE returned no ID token — the LIFF app needs the openid scope in the LINE Developers Console'
    )
  }

  // Done before the first render, not in an effect: the app has nothing to show
  // until it knows whether this person has a record, and doing it here means no
  // component ever renders a "loading who you are" state.
  const session = await startSession(idToken)

  root.render(
    <StrictMode>
      <App idToken={idToken} initialSession={session} />
    </StrictMode>,
  )
}

boot().catch((err: unknown) => {
  root.render(
    <StrictMode>
      <BootFailure
        message={err instanceof Error ? err.message : 'LIFF failed to start'}
      />
    </StrictMode>,
  )
})
