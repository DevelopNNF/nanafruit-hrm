import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import liff from '@line/liff'
import './index.css'
import App from './App.tsx'
import BootFailure from './BootFailure.tsx'

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

  root.render(
    <StrictMode>
      <App />
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
