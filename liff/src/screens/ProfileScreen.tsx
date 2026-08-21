import type { Employee, EmployeeStatus } from '@hrm/shared'
import { PageHeader } from '../components/PageHeader'

type Props = {
  employee: Employee
  onBack: () => void
}

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  Active: 'ปฏิบัติงาน',
  Inactive: 'พ้นสภาพ',
}

function formatDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function ProfileScreen({ employee, onBack }: Props) {
  const { employment } = employee
  const isActive = employment.status === 'Active'

  const shiftText =
    employment.shiftName && employment.shiftStartTime && employment.shiftEndTime
      ? `${employment.shiftName} ${employment.shiftStartTime.slice(0, 5)}–${employment.shiftEndTime.slice(0, 5)}`
      : 'ไม่มีกะที่กำหนดไว้'

  const rows: { key: string; value: string }[] = [
    { key: 'รหัสพนักงาน', value: employee.employeeCode },
    { key: 'ตำแหน่ง', value: employment.jobTitle },
    { key: 'ประเภทการจ้าง', value: employment.employmentType },
    { key: 'วันที่เริ่มงาน', value: formatDate(employment.hireDate) },
    { key: 'กะปัจจุบัน', value: shiftText },
  ]

  return (
    <main className="app">
      <PageHeader title="ข้อมูลพนักงาน" onBack={onBack} />

      <div className="surface-card profile-card">
        <div className="avatar avatar-lg" aria-hidden="true">
          {employee.firstNameTh.charAt(0)}
        </div>
        <p className="name">
          {employee.title}
          {employee.firstNameTh} {employee.lastNameTh}
        </p>
        <span className={`status-pill ${isActive ? 'approved' : 'cancelled'}`}>{STATUS_LABEL[employment.status]}</span>
      </div>

      <div className="surface-card profile-rows">
        {rows.map((row) => (
          <div key={row.key} className="profile-row">
            <span className="profile-row-key">{row.key}</span>
            <span className="profile-row-value">{row.value}</span>
          </div>
        ))}
      </div>

      <p className="hint">ข้อมูลนี้แก้ไขเองไม่ได้ หากไม่ถูกต้องกรุณาแจ้งฝ่ายบุคคล</p>
    </main>
  )
}
