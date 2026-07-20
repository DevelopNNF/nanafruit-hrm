// A minimal TipTap wrapper for Work Instruction. `<fieldset disabled>` only
// greys out native form controls, not a contenteditable div, so `editable` is
// threaded through explicitly rather than relying on the surrounding fieldset.

import { useEffect } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bold, Italic, List, ListOrdered } from 'lucide-react'

type Props = {
  value: string
  onChange: (html: string) => void
  editable: boolean
}

function ToolbarButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex items-center justify-center rounded p-1.5 transition-colors',
        active ? 'bg-slate-200 text-slate-900' : 'text-slate-600 hover:bg-slate-100',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div className="flex gap-1 border-b border-slate-300 px-2 py-1.5">
      <ToolbarButton
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold size={14} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={14} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={14} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={14} />
      </ToolbarButton>
    </div>
  )
}

export function RichTextEditor({ value, onChange, editable }: Props) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: value,
    editable,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  })

  // editable is a prop, not editor state — TipTap only picks up a change to it
  // through this call, not by re-rendering EditorContent.
  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  // Syncs the editor when the draft is replaced from outside (the fetch that
  // loads an existing job). emitUpdate: false so this doesn't loop back into
  // onChange and mark a freshly-loaded draft as edited.
  useEffect(() => {
    if (!editor) return
    if (editor.getHTML() === value) return
    editor.commands.setContent(value, { emitUpdate: false })
  }, [editor, value])

  if (!editor) return null

  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-slate-300 bg-white hover:enabled:border-slate-500">
      {editable && <Toolbar editor={editor} />}
      <EditorContent
        editor={editor}
        className="max-w-none px-3 py-2 text-[0.825rem] text-slate-900
          [&_.ProseMirror]:min-h-24 [&_.ProseMirror]:outline-none
          [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5
          [&_li]:mb-1 [&_p]:mb-2 [&_p:last-child]:mb-0"
      />
    </div>
  )
}
