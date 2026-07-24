import { PageHeader } from '../components/PageHeader'
import { TimeCorrectionCard } from '../components/TimeCorrectionCard'

type Props = {
  onBack: () => void
}

export function TimeCorrectionScreen({ onBack }: Props) {
  return (
    <main className="app">
      <PageHeader title="แก้ไขเวลา" onBack={onBack} />
      <TimeCorrectionCard />
    </main>
  )
}
