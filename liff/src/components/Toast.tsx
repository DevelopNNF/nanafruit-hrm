import { useEffect } from 'react'

type Props = {
  message: string
  onDone: () => void
  duration?: number
}

export function Toast({ message, onDone, duration = 2500 }: Props) {
  useEffect(() => {
    const timer = setTimeout(onDone, duration)
    return () => clearTimeout(timer)
  }, [onDone, duration])

  return (
    <div className="toast" role="status">
      {message}
    </div>
  )
}
