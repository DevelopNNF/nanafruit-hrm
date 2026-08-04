import { PageHeader } from '../components/PageHeader'
import { ShiftChangeRequestCard } from '../components/ShiftChangeRequestCard'

type Props = {
  onBack: () => void
}

export function ShiftChangeRequestScreen({ onBack }: Props) {
  return (
    <main className="app">
      <PageHeader title="ขอเปลี่ยนกะ" onBack={onBack} />
      <ShiftChangeRequestCard />
    </main>
  )
}
