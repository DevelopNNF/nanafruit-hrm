import { useEffect, useState } from 'react'
import liff from '@line/liff'
import type { Employee, LineSessionResponse } from '@hrm/shared'
import { LinkScreen } from './LinkScreen'
import { AttendanceCard } from './AttendanceCard'
import { TimeCorrectionCard } from './TimeCorrectionCard'
import { LeaveRequestCard } from './LeaveRequestCard'
import './App.css'

type Profile = {
  displayName: string
  pictureUrl?: string
}

type Props = {
  idToken: string
  /** null when LINE knows this person but no employee record claims them yet. */
  initialSession: LineSessionResponse | null
}

function EmployeeHome({ employee }: { employee: Employee }) {
  const [profile, setProfile] = useState<Profile | null>(null)

  useEffect(() => {
    // Display only. Anything the server is asked to trust has to come from
    // liff.getIDToken() and be verified against LINE server-side — a client can
    // claim any profile it likes, so this name is decoration, not identity.
    // The name below it, in the card, is the one the server vouches for.
    liff.getProfile().then(
      (p) => setProfile({ displayName: p.displayName, pictureUrl: p.pictureUrl }),
      () => {
        // Decoration failing to load is not worth surfacing.
      },
    )
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
      <p className="subtitle">ข้อมูลพนักงานของคุณ</p>

      <AttendanceCard />

      <TimeCorrectionCard />

      <LeaveRequestCard employee={employee} />

      <div className="card ok">
        <p className="headline">
          {employee.title}
          {employee.firstNameTh} {employee.lastNameTh}
        </p>
        <dl>
          <dt>รหัสพนักงาน</dt>
          <dd>{employee.employeeCode}</dd>
          <dt>ตำแหน่ง</dt>
          <dd>{employee.employment.jobTitle}</dd>
          <dt>ประเภท</dt>
          <dd>{employee.employment.employmentType}</dd>
          <dt>วันที่เริ่มงาน</dt>
          <dd>{employee.employment.hireDate}</dd>
          <dt>สถานะ</dt>
          <dd>{employee.employment.status}</dd>
        </dl>
      </div>
    </main>
  )
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
