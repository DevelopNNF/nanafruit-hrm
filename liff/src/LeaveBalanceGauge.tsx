type Props = {
  usedDays: number
  pendingDays: number
  remainingDays: number
}

/** Stacked bar: green = already used, yellow = awaiting approval, and
 *  whatever's left unfilled is just the track's own gray background — the
 *  free remaining balance, drawn by absence rather than a third segment. */
export function LeaveBalanceGauge({ usedDays, pendingDays, remainingDays }: Props) {
  const freeRemaining = remainingDays - pendingDays

  return (
    <div className="leave-gauge">
      <div className="leave-gauge-track">
        <div className="leave-gauge-used" style={{ flexGrow: usedDays }} />
        <div className="leave-gauge-pending" style={{ flexGrow: pendingDays }} />
      </div>
      <div className="leave-gauge-legend">
        <span className="leave-gauge-legend-item used">ใช้ไป {usedDays}</span>
        <span className="leave-gauge-legend-item pending">รออนุมัติ {pendingDays}</span>
        <span className="leave-gauge-legend-item remaining">คงเหลือ {freeRemaining}</span>
      </div>
    </div>
  )
}
