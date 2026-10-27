import * as React from "react"
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Hash,
  KeyRound,
  List,
  type LucideIcon,
  Plus,
  Sparkles,
  ToggleLeft,
  Trash2,
  Type,
  Wand2,
} from "lucide-react"

import type { BrickV2Input, BrickV2InputType } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { cn } from "@workspace/ui/lib/utils"

import { useIssueCount } from "~/components/bricks/creator/creator-fields"
import type { Edit } from "~/components/bricks/creator/creator-edit"

export const inputTypeMeta: Record<
  BrickV2InputType,
  { description: string; icon: LucideIcon; label: string }
> = {
  text: { label: "Text", icon: Type, description: "A word, version, or line" },
  number: { label: "Number", icon: Hash, description: "A count or amount" },
  boolean: { label: "Toggle", icon: ToggleLeft, description: "On or off" },
  select: { label: "Choice", icon: List, description: "One of a list" },
  secret: {
    label: "Secret",
    icon: KeyRound,
    description: "A password or token, hidden",
  },
}

export const inputTypes = Object.keys(inputTypeMeta) as Array<BrickV2InputType>

// Adds a question of a type after the others, keyed until it gets a label.
export function addInput(edit: Edit, type: BrickV2InputType): void {
  edit((brick) => {
    const current = brick.inputs ?? []
    const taken = new Set(current.map((input) => input.key))
    let index = current.length + 1
    while (taken.has(`${type}_${index}`)) index += 1
    const input: BrickV2Input = {
      key: `${type}_${index}`,
      label: "",
      type,
      ...(type === "select" ? { options: ["one", "two"] } : {}),
      ...(type === "secret" ? { generate: true } : {}),
    }
    return { ...brick, inputs: [...current, input] }
  })
}

export function moveInput(edit: Edit, index: number, offset: number): void {
  edit((brick) => {
    const next = [...(brick.inputs ?? [])]
    if (index + offset < 0 || index + offset >= next.length) return brick
    const [moved] = next.splice(index, 1)
    next.splice(index + offset, 0, moved!)
    return { ...brick, inputs: next }
  })
}

export function removeInput(edit: Edit, index: number): void {
  edit((brick) => ({
    ...brick,
    inputs: (brick.inputs ?? []).filter((_, other) => other !== index),
  }))
}

// The install form, one row per question. Rows open a dialog to edit; the
// section stays a summary.
export const InputsCard = React.memo(function InputsCard({
  edit,
  inputs,
  onOpen,
}: {
  edit: Edit
  inputs: ReadonlyArray<BrickV2Input> | undefined
  onOpen: (index: number) => void
}) {
  const list = inputs ?? []
  const add = (type: BrickV2InputType) => {
    addInput(edit, type)
    onOpen(list.length)
  }
  const move = (index: number, offset: number) => moveInput(edit, index, offset)
  const remove = (index: number) => removeInput(edit, index)

  return (
    <section aria-label="Install form">
      <SectionHeader
        title="Install form"
        detail={
          list.length === 0
            ? "Asks only for a name"
            : `A name and ${list.length} ${list.length === 1 ? "question" : "questions"}`
        }
        action={<AddInputMenu onAdd={add} />}
      />
      {list.length === 0 ? (
        <div className="flex flex-col gap-3 px-4 py-4">
          <p className="type-support text-muted-foreground">
            Add a question for anything the person installing it should choose,
            like a version or a password.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {inputTypes.map((type) => {
              const Icon = inputTypeMeta[type].icon
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => add(type)}
                  className="type-control-sm flex h-8 items-center gap-1.5 border border-dashed border-border px-2.5 text-muted-foreground transition-colors outline-none hover:border-primary/50 hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:bg-accent/70"
                >
                  <Icon className="size-3.5" />
                  {inputTypeMeta[type].label}
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <ol>
          {list.map((input, index) => (
            <InputRow
              key={index}
              count={list.length}
              index={index}
              input={input}
              onMove={move}
              onOpen={onOpen}
              onRemove={remove}
            />
          ))}
        </ol>
      )}
    </section>
  )
})

// A section's heading row in the sheet: its name, a word on its state, and
// what it can do.
export function SectionHeader({
  action,
  detail,
  title,
}: {
  action?: React.ReactNode
  detail?: React.ReactNode
  title: string
}) {
  return (
    <header className="flex h-10 items-center gap-3 border-y border-border bg-card/35 pr-2 pl-4">
      <h2 className="type-card-title">{title}</h2>
      {detail ? (
        <span className="type-meta min-w-0 truncate text-muted-foreground">
          {detail}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div>
    </header>
  )
}

function AddInputMenu({ onAdd }: { onAdd: (type: BrickV2InputType) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <Plus />
          Add question
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {inputTypes.map((type) => {
          const { description, icon: Icon, label } = inputTypeMeta[type]
          return (
            <DropdownMenuItem key={type} onSelect={() => onAdd(type)}>
              <Icon className="text-muted-foreground" />
              <span className="flex flex-col">
                <span>{label}</span>
                <span className="type-meta text-muted-foreground">
                  {description}
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const InputRow = React.memo(function InputRow({
  count,
  index,
  input,
  onMove,
  onOpen,
  onRemove,
}: {
  count: number
  index: number
  input: BrickV2Input
  onMove: (index: number, offset: number) => void
  onOpen: (index: number) => void
  onRemove: (index: number) => void
}) {
  const issues = useIssueCount(`inputs.${index}`)
  const Icon = inputTypeMeta[input.type]?.icon ?? Type
  const value =
    input.type === "secret"
      ? input.generate
        ? null
        : "••••••"
      : input.default === undefined
        ? null
        : String(input.default)

  return (
    <li className="group relative flex items-center border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => onOpen(index)}
        className="flex h-10 min-w-0 flex-1 items-center gap-3 px-4 text-left transition-colors outline-none hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset active:bg-accent/60 md:pr-28"
      >
        <span
          className={cn(
            "grid size-6 shrink-0 place-items-center border bg-background",
            issues > 0
              ? "border-destructive/50 text-destructive"
              : "border-border text-muted-foreground"
          )}
        >
          {issues > 0 ? (
            <CircleAlert className="size-3.5" />
          ) : (
            <Icon className="size-3.5" />
          )}
        </span>
        <span className="type-control truncate">
          {input.label || (
            <span className="text-muted-foreground">Untitled question</span>
          )}
        </span>
        <code className="type-code hidden truncate text-[0.75rem] text-muted-foreground/70 sm:inline">
          {input.key}
        </code>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {input.suggest ? (
            <Badge title="Default follows another answer">
              <Wand2 className="size-3" />
              follows {input.suggest[0]!.when}
            </Badge>
          ) : null}
          {input.type === "secret" && input.generate ? (
            <Badge>
              <Sparkles className="size-3" />
              generated
            </Badge>
          ) : null}
          {input.optional ? <Badge>optional</Badge> : null}
          {input.advanced ? <Badge>advanced</Badge> : null}
          {value !== null ? (
            <code className="type-code max-w-28 truncate text-[0.75rem] text-foreground/80">
              {value}
            </code>
          ) : null}
        </span>
      </button>
      <span className="absolute right-2 hidden items-center gap-0.5 bg-background opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 md:flex">
        <RowAction
          label="Move up"
          disabled={index === 0}
          onClick={() => onMove(index, -1)}
        >
          <ArrowUp />
        </RowAction>
        <RowAction
          label="Move down"
          disabled={index === count - 1}
          onClick={() => onMove(index, 1)}
        >
          <ArrowDown />
        </RowAction>
        <RowAction label="Remove" onClick={() => onRemove(index)}>
          <Trash2 />
        </RowAction>
      </span>
    </li>
  )
})

function Badge({
  children,
  title,
}: {
  children: React.ReactNode
  title?: string
}) {
  return (
    <span
      title={title}
      className="type-label hidden h-5 items-center gap-1 border border-border px-1.5 text-muted-foreground md:inline-flex"
    >
      {children}
    </span>
  )
}

function RowAction({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(label === "Remove" && "hover:text-destructive")}
    >
      {children}
    </Button>
  )
}
