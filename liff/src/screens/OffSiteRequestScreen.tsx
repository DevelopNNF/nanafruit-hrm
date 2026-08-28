import { OffSiteRequestCard } from '../components/OffSiteRequestCard'

type Props = {
  onBack: () => void
}

export function OffSiteRequestScreen({ onBack }: Props) {
  return <OffSiteRequestCard onBack={onBack} />
}
