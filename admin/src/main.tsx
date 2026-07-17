import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MsalProvider } from '@azure/msal-react'
import './index.css'
import App from './App.tsx'
import BootFailure from './BootFailure.tsx'
import { AuthGate } from './auth/AuthGate.tsx'
import { MeProvider } from './auth/MeProvider.tsx'
import { initMsal } from './auth/msal.ts'

const root = createRoot(document.getElementById('root')!)

// initialize() must resolve before any component touches MSAL, so the app is
// rendered from inside boot() rather than at module scope.
async function boot() {
  const instance = await initMsal()

  root.render(
    <StrictMode>
      <MsalProvider instance={instance}>
        {/* AuthGate first: MeProvider needs a token to ask with. */}
        <AuthGate>
          <MeProvider>
            <App />
          </MeProvider>
        </AuthGate>
      </MsalProvider>
    </StrictMode>,
  )
}

boot().catch((err: unknown) => {
  root.render(
    <StrictMode>
      <BootFailure
        message={err instanceof Error ? err.message : 'sign-in failed to start'}
      />
    </StrictMode>,
  )
})
