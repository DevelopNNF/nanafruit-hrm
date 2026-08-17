import { PageHeader } from '../components/PageHeader'
import { OvertimeRequestCard } from '../components/OvertimeRequestCard'

type Props = {
  onBack: () => void
}

export function OvertimeRequestScreen({ onBack }: Props) {
  return (
    <main className="app">
      <PageHeader title="ขอทำงานล่วงเวลา (OT)" onBack={onBack} />
      <OvertimeRequestCard />
    </main>
  )
}
