import type { Employee } from '@hrm/shared'
import { PageHeader } from '../components/PageHeader'
import { LeaveRequestCard } from '../components/LeaveRequestCard'

type Props = {
  employee: Employee
  onBack: () => void
}

export function LeaveScreen({ employee, onBack }: Props) {
  return (
    <main className="app">
      <PageHeader title="คำขอลา" onBack={onBack} />
      <LeaveRequestCard employee={employee} />
    </main>
  )
}
