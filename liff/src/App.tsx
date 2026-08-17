import { useEffect, useState } from 'react'
import type { Employee, LineSessionResponse } from '@hrm/shared'
import { LinkScreen } from './screens/LinkScreen'
import { HomeScreen, type SubScreen } from './screens/HomeScreen'
import { LeaveScreen } from './screens/LeaveScreen'
import { TimeCorrectionScreen } from './screens/TimeCorrectionScreen'
import { ShiftChangeRequestScreen } from './screens/ShiftChangeRequestScreen'
import { DayOffSwapRequestScreen } from './screens/DayOffSwapRequestScreen'
import { OvertimeRequestScreen } from './screens/OvertimeRequestScreen'
import { ProfileScreen } from './screens/ProfileScreen'
import { CalendarScreen } from './screens/CalendarScreen'
import './App.css'

type Props = {
  idToken: string
  /** null when LINE knows this person but no employee record claims them yet. */
  initialSession: LineSessionResponse | null
}

type Screen = 'home' | SubScreen

const HISTORY_STATE_KEY = 'liffSubScreen'

function EmployeeHome({ employee }: { employee: Employee }) {
  const [screen, setScreen] = useState<Screen>('home')

  useEffect(() => {
    // The LINE in-app browser on Android maps the hardware/gesture back button
    // to browser history. Without a history entry for sub-screens, pressing
    // back on one would exit the LIFF window instead of returning home.
    function onPopState() {
      setScreen('home')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  function navigate(next: SubScreen) {
    history.pushState({ [HISTORY_STATE_KEY]: next }, '')
    setScreen(next)
  }

  function back() {
    history.back()
  }

  if (screen === 'leave') return <LeaveScreen employee={employee} onBack={back} />
  if (screen === 'correction') return <TimeCorrectionScreen onBack={back} />
  if (screen === 'shiftChange') return <ShiftChangeRequestScreen onBack={back} />
  if (screen === 'dayOffSwap') return <DayOffSwapRequestScreen onBack={back} />
  if (screen === 'overtime') return <OvertimeRequestScreen onBack={back} />
  if (screen === 'profile') return <ProfileScreen employee={employee} onBack={back} />
  if (screen === 'calendar') return <CalendarScreen onBack={back} />
  return <HomeScreen onNavigate={navigate} />
}

function App({ idToken, initialSession }: Props) {
  const [session, setSession] = useState(initialSession)

  // Linking succeeds straight into a session, so the link screen hands one back
  // and this swaps over — no reload, no second trip through boot().
  if (session === null) {
    return <LinkScreen idToken={idToken} onLinked={setSession} />
  }
  return <EmployeeHome employee={session.employee} />
}

export default App
