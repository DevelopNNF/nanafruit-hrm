import { CompTimeOffRequestCard } from '../components/CompTimeOffRequestCard'

type Props = {
  onBack: () => void
}

export function CompTimeOffRequestScreen({ onBack }: Props) {
  return <CompTimeOffRequestCard onBack={onBack} />
}
