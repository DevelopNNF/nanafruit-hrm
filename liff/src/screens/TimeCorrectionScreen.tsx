import { TimeCorrectionCard } from '../components/TimeCorrectionCard'

type Props = {
  onBack: () => void
}

export function TimeCorrectionScreen({ onBack }: Props) {
  return <TimeCorrectionCard onBack={onBack} />
}
