import { ShiftChangeRequestCard } from '../components/ShiftChangeRequestCard'

type Props = {
  onBack: () => void
}

export function ShiftChangeRequestScreen({ onBack }: Props) {
  return <ShiftChangeRequestCard onBack={onBack} />
}
