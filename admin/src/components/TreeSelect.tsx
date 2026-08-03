// A dropdown for picking from a parent/child hierarchy (e.g. Department),
// rendered as an indented, expandable tree instead of a flat <select> — so
// the structure is visible instead of a flat alphabetical list. Single mode
// behaves like a combobox (pick one, popover closes); multiple mode adds
// checkboxes with cascading selection (checking a parent checks every
// descendant, and a parent shows an indeterminate dash while only some of
// its children are checked).

import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Minus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { cn } from '../lib/utils'

export type TreeSelectOption = {
  id: number
  label: string
  /** FK to another option's id in the same list, or null for a root node. */
  parentId: number | null
}

type TreeNode = TreeSelectOption & { children: TreeNode[] }

type BaseProps = {
  options: TreeSelectOption[]
  placeholder?: string
  disabled?: boolean
  loading?: boolean
  required?: boolean
  className?: string
}

type SingleProps = BaseProps & {
  mode: 'single'
  value: number | null
  onChange: (value: number | null) => void
  /** Label for the "no selection" row. Omit when the field can't be cleared. */
  clearLabel?: string
}

type MultipleProps = BaseProps & {
  mode: 'multiple'
  value: number[]
  onChange: (value: number[]) => void
}

export type TreeSelectProps = SingleProps | MultipleProps

function buildTree(options: TreeSelectOption[]): TreeNode[] {
  const byId = new Map<number, TreeNode>()
  for (const option of options) byId.set(option.id, { ...option, children: [] })

  const roots: TreeNode[] = []
  for (const option of options) {
    const node = byId.get(option.id)!
    const parent = option.parentId !== null ? byId.get(option.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

function ancestorIds(id: number, byId: Map<number, TreeSelectOption>): number[] {
  const ids: number[] = []
  let current = byId.get(id)
  while (current && current.parentId !== null) {
    ids.push(current.parentId)
    current = byId.get(current.parentId)
  }
  return ids
}

function descendantIds(node: TreeNode): number[] {
  const ids: number[] = []
  for (const child of node.children) {
    ids.push(child.id, ...descendantIds(child))
  }
  return ids
}

function findNode(nodes: TreeNode[], id: number): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return undefined
}

function hasCheckedDescendant(node: TreeNode, checked: Set<number>): boolean {
  return node.children.some((child) => checked.has(child.id) || hasCheckedDescendant(child, checked))
}

const triggerClass =
  'flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-2.5 py-2 text-left text-[0.825rem] text-slate-900 hover:enabled:border-slate-500 disabled:bg-slate-100 disabled:text-slate-900 disabled:opacity-100'

function Row({
  depth,
  label,
  hasChildren,
  isExpanded,
  onToggleExpanded,
  mode,
  checked,
  indeterminate,
  selected,
  onActivate,
}: {
  depth: number
  label: string
  hasChildren: boolean
  isExpanded: boolean
  onToggleExpanded: () => void
  mode: 'single' | 'multiple'
  checked: boolean
  indeterminate: boolean
  selected: boolean
  onActivate: () => void
}) {
  return (
    <div className="flex items-center" style={{ paddingLeft: `${depth * 1}rem` }}>
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggleExpanded}
          className="flex size-6 shrink-0 items-center justify-center text-slate-400 hover:text-slate-600"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', isExpanded && 'rotate-90')} />
        </button>
      ) : (
        <span className="size-6 shrink-0" />
      )}
      <button
        type="button"
        role={mode === 'single' ? 'option' : 'checkbox'}
        aria-selected={mode === 'single' ? selected : undefined}
        aria-checked={mode === 'multiple' ? (indeterminate ? 'mixed' : checked) : undefined}
        onClick={onActivate}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[0.8rem] hover:bg-slate-100',
          mode === 'single' && selected ? 'font-medium text-navy' : 'text-slate-900',
        )}
      >
        {mode === 'multiple' && (
          <span
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded border',
              checked || indeterminate ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white',
            )}
          >
            {checked && <Check className="size-3" />}
            {!checked && indeterminate && <Minus className="size-3" />}
          </span>
        )}
        <span className="truncate">{label}</span>
        {mode === 'single' && selected && <Check className="ml-auto size-3.5 shrink-0 text-navy" />}
      </button>
    </div>
  )
}

function TreeBranch({
  node,
  depth,
  mode,
  expanded,
  onToggleExpanded,
  singleValue,
  checkedSet,
  onSelectSingle,
  onToggleMultiple,
}: {
  node: TreeNode
  depth: number
  mode: 'single' | 'multiple'
  expanded: Set<number>
  onToggleExpanded: (id: number) => void
  singleValue: number | null
  checkedSet: Set<number>
  onSelectSingle: (id: number) => void
  onToggleMultiple: (node: TreeNode) => void
}) {
  const isExpanded = expanded.has(node.id)
  const hasChildren = node.children.length > 0
  const checked = checkedSet.has(node.id)
  const indeterminate = !checked && hasChildren && hasCheckedDescendant(node, checkedSet)

  return (
    <>
      <Row
        depth={depth}
        label={node.label}
        hasChildren={hasChildren}
        isExpanded={isExpanded}
        onToggleExpanded={() => onToggleExpanded(node.id)}
        mode={mode}
        checked={checked}
        indeterminate={indeterminate}
        selected={mode === 'single' && singleValue === node.id}
        onActivate={() => (mode === 'single' ? onSelectSingle(node.id) : onToggleMultiple(node))}
      />
      {hasChildren &&
        isExpanded &&
        node.children.map((child) => (
          <TreeBranch
            key={child.id}
            node={child}
            depth={depth + 1}
            mode={mode}
            expanded={expanded}
            onToggleExpanded={onToggleExpanded}
            singleValue={singleValue}
            checkedSet={checkedSet}
            onSelectSingle={onSelectSingle}
            onToggleMultiple={onToggleMultiple}
          />
        ))}
    </>
  )
}

export function TreeSelect(props: TreeSelectProps) {
  const { options, placeholder, disabled, loading, required, className } = props
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const tree = useMemo(() => buildTree(options), [options])
  const byId = useMemo(() => new Map(options.map((option) => [option.id, option])), [options])
  const checkedSet = useMemo(
    () => new Set(props.mode === 'multiple' ? props.value : []),
    [props.mode, props.value],
  )

  // Reveal the current selection's ancestor chain whenever the popover
  // opens, so picking from a deep branch doesn't mean re-expanding it by hand
  // every time. Driven from the open-change event rather than an effect,
  // since this only ever needs to run in response to that one trigger.
  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) return
    const currentIds = props.mode === 'single' ? (props.value === null ? [] : [props.value]) : props.value
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const id of currentIds) {
        for (const ancestor of ancestorIds(id, byId)) next.add(ancestor)
      }
      return next
    })
  }

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectSingle(id: number | null) {
    if (props.mode !== 'single') return
    props.onChange(id)
    setOpen(false)
  }

  function toggleMultiple(node: TreeNode) {
    if (props.mode !== 'multiple') return
    const next = new Set(checkedSet)
    const subtreeIds = [node.id, ...descendantIds(node)]
    const nowChecking = !next.has(node.id)

    for (const id of subtreeIds) {
      if (nowChecking) next.add(id)
      else next.delete(id)
    }

    // Bubble up: an ancestor is only "checked" once every one of its direct
    // children is, so re-derive each ancestor from its children rather than
    // assuming this toggle's direction applies to them too.
    for (const ancestorId of ancestorIds(node.id, byId)) {
      const ancestorNode = findNode(tree, ancestorId)
      if (!ancestorNode) continue
      const allChildrenChecked = ancestorNode.children.every((child) => next.has(child.id))
      if (allChildrenChecked) next.add(ancestorId)
      else next.delete(ancestorId)
    }

    props.onChange(Array.from(next))
  }

  const triggerEmpty = props.mode === 'single' ? props.value === null : props.value.length === 0

  const triggerLabel = loading
    ? 'กำลังโหลด…'
    : props.mode === 'single'
      ? props.value === null
        ? (props.clearLabel ?? placeholder ?? '— เลือก —')
        : (byId.get(props.value)?.label ?? placeholder ?? '— เลือก —')
      : props.value.length === 0
        ? (placeholder ?? '— เลือก —')
        : `${props.value.length} รายการที่เลือก`

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <div className="relative min-w-0">
        <PopoverTrigger asChild>
          <button type="button" disabled={disabled || loading} className={cn(triggerClass, className)}>
            <span className={cn('truncate', triggerEmpty && 'text-slate-400')}>{triggerLabel}</span>
            <ChevronDown className="size-4 shrink-0 text-slate-400" />
          </button>
        </PopoverTrigger>

        {/* Keeps the surrounding <form>'s required/validity behavior working
            without needing the trigger itself to be a form control. */}
        {required && (
          <input
            tabIndex={-1}
            aria-hidden
            required
            value={triggerEmpty ? '' : 'x'}
            onChange={() => {}}
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0 w-full opacity-0"
          />
        )}
      </div>

      <PopoverContent align="start" className="max-h-80 w-72 overflow-y-auto p-1.5">
        {props.mode === 'single' && props.clearLabel && (
          <Row
            depth={0}
            label={props.clearLabel}
            hasChildren={false}
            isExpanded={false}
            onToggleExpanded={() => {}}
            mode="single"
            checked={false}
            indeterminate={false}
            selected={props.value === null}
            onActivate={() => selectSingle(null)}
          />
        )}
        {tree.length === 0 && (
          <p className="px-2 py-3 text-center text-[0.775rem] text-slate-400">ไม่มีรายการ</p>
        )}
        {tree.map((node) => (
          <TreeBranch
            key={node.id}
            node={node}
            depth={0}
            mode={props.mode}
            expanded={expanded}
            onToggleExpanded={toggleExpanded}
            singleValue={props.mode === 'single' ? props.value : null}
            checkedSet={checkedSet}
            onSelectSingle={selectSingle}
            onToggleMultiple={toggleMultiple}
          />
        ))}
      </PopoverContent>
    </Popover>
  )
}
