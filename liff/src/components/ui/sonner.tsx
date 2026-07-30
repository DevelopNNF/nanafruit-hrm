import { Toaster as SonnerToaster, type ToasterProps } from 'sonner'

/** Replaces the hand-rolled <Toast> — same bottom-centre pill look, but
 *  Sonner owns the stacking/animation/auto-dismiss instead of each call site
 *  managing its own timer and local state. `unstyled` strips Sonner's default
 *  card chrome so only these classes (not its border/padding) apply. */
export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="light"
      position="bottom-center"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'rounded-full bg-text-h px-5 py-3 text-[0.85rem] font-semibold text-white shadow-lg whitespace-nowrap',
        },
      }}
      {...props}
    />
  )
}
