import { DayOffSwapRequestCard } from '../components/DayOffSwapRequestCard'

type Props = {
  onBack: () => void
}

export function DayOffSwapRequestScreen({ onBack }: Props) {
  return <DayOffSwapRequestCard onBack={onBack} />
}
