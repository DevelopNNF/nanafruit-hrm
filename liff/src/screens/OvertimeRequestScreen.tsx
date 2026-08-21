import { OvertimeRequestCard } from '../components/OvertimeRequestCard'

type Props = {
  onBack: () => void
}

export function OvertimeRequestScreen({ onBack }: Props) {
  return <OvertimeRequestCard onBack={onBack} />
}
