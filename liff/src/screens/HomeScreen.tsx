import { useEffect, useState } from 'react'
import liff from '@line/liff'
import type { Employee } from '@hrm/shared'
import { AttendanceCard } from '../components/AttendanceCard'
import { HomeLeaveBalances } from '../components/HomeLeaveBalances'
import { ApprovalInboxTile } from '../components/ApprovalInboxTile'

type Profile = {
  displayName: string
  pictureUrl?: string
}

export type SubScreen =
  | 'leave'
  | 'correction'
  | 'shiftChange'
  | 'dayOffSwap'
  | 'overtime'
  | 'compTimeOff'
  | 'offSite'
  | 'profile'
  | 'calendar'
  | 'approvals'
  | 'payslip'

type Tile = {
  screen: SubScreen
  label: string
  en: string
}

const TILES: Tile[] = [
  { screen: 'payslip', label: 'สลิปเงินเดือน', en: 'Payslip' },
  { screen: 'leave', label: 'ลา', en: 'Leave' },
  { screen: 'correction', label: 'แก้ไขเวลา', en: 'TimeCorrection' },
  { screen: 'shiftChange', label: 'ขอเปลี่ยนกะ', en: 'ShiftChange' },
  { screen: 'dayOffSwap', label: 'สลับวันหยุด', en: 'DayOffSwap' },
  { screen: 'overtime', label: 'ขอทำงานล่วงเวลา (OT)', en: 'Overtime' },
  { screen: 'compTimeOff', label: 'ใช้วันหยุดสะสม', en: 'CompTimeOff' },
  { screen: 'offSite', label: 'ทำงานนอกสถานที่', en: 'OffSiteWork' },
  { screen: 'profile', label: 'ข้อมูลพนักงาน', en: 'Profile' },
]

type Props = {
  employee: Employee
  isSupervisor: boolean
  onNavigate: (screen: SubScreen) => void
}

export function HomeScreen({ employee, isSupervisor, onNavigate }: Props) {
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

  const displayName = profile?.displayName ?? `${employee.title}${employee.firstNameTh} ${employee.lastNameTh}`

  return (
    <main className="app">
      <header className="profile">
        {profile?.pictureUrl ? (
          <img src={profile.pictureUrl} alt="" width={46} height={46} />
        ) : (
          <div className="avatar" aria-hidden="true">
            {displayName.trim().charAt(0)}
          </div>
        )}
        <div className="profile-text">
          <p className="greeting">สวัสดี</p>
          <p className="name">{displayName}</p>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => onNavigate('profile')}
          aria-label="ข้อมูลพนักงาน"
        >
          ☰
        </button>
      </header>

      <AttendanceCard />

      <HomeLeaveBalances employee={employee} onViewAll={() => onNavigate('leave')} />

      <ApprovalInboxTile isSupervisor={isSupervisor} onNavigate={() => onNavigate('approvals')} />

      <nav className="home-tiles">
        <button
          type="button"
          className="home-tile-calendar"
          onClick={() => onNavigate('calendar')}
        >
          <span className="home-tile-calendar-icon">
            {new Date().getDate()}
          </span>
          <span className="home-tile-calendar-text">
            <span className="home-tile-calendar-label">ปฏิทินการทำงาน</span>
            <span className="home-tile-calendar-sub">กะ วันหยุด และวันลาของเดือนนี้</span>
          </span>
          <span className="home-tile-calendar-arrow" aria-hidden="true">
            →
          </span>
        </button>

        {TILES.map((tile) => (
          <button
            type="button"
            key={tile.screen}
            className="home-tile"
            onClick={() => onNavigate(tile.screen)}
          >
            <span className="home-tile-top">
              <span className="home-tile-dot" aria-hidden="true" />
            </span>
            <span>
              <span className="home-tile-label">{tile.label}</span>
              <span className="home-tile-en">{tile.en}</span>
            </span>
          </button>
        ))}
      </nav>
    </main>
  )
}
