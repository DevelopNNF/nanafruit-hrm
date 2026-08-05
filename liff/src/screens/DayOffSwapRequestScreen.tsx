import { PageHeader } from '../components/PageHeader'
import { DayOffSwapRequestCard } from '../components/DayOffSwapRequestCard'

type Props = {
  onBack: () => void
}

export function DayOffSwapRequestScreen({ onBack }: Props) {
  return (
    <main className="app">
      <PageHeader title="สลับวันหยุด" onBack={onBack} />
      <DayOffSwapRequestCard />
    </main>
  )
}
