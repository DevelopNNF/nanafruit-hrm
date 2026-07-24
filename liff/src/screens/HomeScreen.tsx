import { useEffect, useState } from 'react'
import liff from '@line/liff'
import { AttendanceCard } from '../components/AttendanceCard'

type Profile = {
  displayName: string
  pictureUrl?: string
}

export type SubScreen = 'leave' | 'correction' | 'profile'

type Props = {
  onNavigate: (screen: SubScreen) => void
}

export function HomeScreen({ onNavigate }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null)

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

      <nav className="nav-list">
        <button type="button" className="nav-item" onClick={() => onNavigate('leave')}>
          ลา
          <span aria-hidden="true">→</span>
        </button>
        <button type="button" className="nav-item" onClick={() => onNavigate('correction')}>
          แก้ไขเวลา
          <span aria-hidden="true">→</span>
        </button>
        <button type="button" className="nav-item" onClick={() => onNavigate('profile')}>
          ข้อมูลพนักงาน
          <span aria-hidden="true">→</span>
        </button>
      </nav>
    </main>
  )
}
