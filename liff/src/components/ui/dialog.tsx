import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'

/** Thin wrapper over Radix's Dialog that keeps the existing .modal-* look
 *  (see App.css) — Radix supplies the focus trap, Escape handling, and
 *  portal rendering that ConfirmModal used to be missing. */

const Dialog = DialogPrimitive.Root

function DialogOverlay(props: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay className="modal-overlay" {...props} />
}

function DialogContent({ children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content className="modal-dialog" {...props}>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function DialogTitle(props: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className="modal-title" {...props} />
}

function DialogDescription(props: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className="modal-message" {...props} />
}

export { Dialog, DialogContent, DialogDescription, DialogTitle }
