import type { Employee } from '@hrm/shared'
import { PageHeader } from '../components/PageHeader'

type Props = {
  employee: Employee
  onBack: () => void
}

export function ProfileScreen({ employee, onBack }: Props) {
  return (
    <main className="app">
      <PageHeader title="ข้อมูลพนักงาน" onBack={onBack} />
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
