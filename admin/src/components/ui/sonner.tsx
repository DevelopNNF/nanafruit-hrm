import { Toaster as SonnerToaster, type ToasterProps } from 'sonner'

/** Positioning/theme only — each call site supplies its own look via
 *  `className: toastCard(tone)` (see notifications/notify.tsx), the same way
 *  it did with react-hot-toast. `unstyled` drops Sonner's own card chrome
 *  (background/border/padding) so toastCard() is the only thing drawing it —
 *  without it the two sets of styles would compete. */
export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="light"
      position="bottom-right"
      toastOptions={{ unstyled: true }}
      {...props}
    />
  )
}
