import type { Employee } from '@hrm/shared'
import { LeaveRequestCard } from '../components/LeaveRequestCard'

type Props = {
  employee: Employee
  onBack: () => void
}

export function LeaveScreen({ employee, onBack }: Props) {
  return <LeaveRequestCard employee={employee} onBack={onBack} />
}
