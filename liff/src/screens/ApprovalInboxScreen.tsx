import { ApprovalInboxCard } from '../components/ApprovalInboxCard'

type Props = {
  onBack: () => void
}

export function ApprovalInboxScreen({ onBack }: Props) {
  return <ApprovalInboxCard onBack={onBack} />
}
