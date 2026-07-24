type Props = {
  title: string
  onBack: () => void
}

export function PageHeader({ title, onBack }: Props) {
  return (
    <div className="page-header">
      <button type="button" className="back-button" onClick={onBack} aria-label="ย้อนกลับ">
        ←
      </button>
      <h1>{title}</h1>
    </div>
  )
}
