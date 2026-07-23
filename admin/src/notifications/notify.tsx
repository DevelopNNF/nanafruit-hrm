// One door out for CRUD feedback, the same way api/client.ts is the one door
// out to the server — a page reaches for notify.* instead of reinventing a
// toast call, so every page's wording lands in the same visual language.

import toast from 'react-hot-toast'
import { toastCard } from '../styles'

function body(title: string, message?: string) {
  if (!message) return title
  return (
    <div>
      <p className="font-semibold">{title}</p>
      <p className="mt-0.5 text-xs opacity-80">{message}</p>
    </div>
  )
}

export const notify = {
    success: (title: string, message?: string) =>
      toast.success(body(title, message), { duration: 3500, className: toastCard('ok') }),
    error: (title: string, message?: string) =>
      toast.error(body(title, message), { duration: 6000, className: toastCard('danger') }),
    info: (title: string, message?: string) =>
      toast(body(title, message), { duration: 3500, className: toastCard('info') }),
  }
