import * as React from "react"

import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"

import {
  type CreatorIssue,
  fieldDomId,
} from "~/components/bricks/creator/creator-state"

// Each field reads its own problem from here, so a change in one field's
// problem redraws that field and not the whole form.
export class IssueStore {
  #byPath = new Map<string, string>()
  #listeners = new Set<() => void>()

  set(issues: ReadonlyArray<CreatorIssue>): void {
    const byPath = new Map<string, string>()
    for (const issue of issues) {
      if (!byPath.has(issue.path)) byPath.set(issue.path, issue.message)
    }
    this.#byPath = byPath
    for (const listener of this.#listeners) listener()
  }

  get = (path: string): string | undefined => this.#byPath.get(path)

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}

export const IssueStoreContext = React.createContext<IssueStore | null>(null)

export function useIssue(path: string | undefined): string | undefined {
  const store = React.useContext(IssueStoreContext)
  return React.useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => (path === undefined ? undefined : store?.get(path)),
    () => undefined
  )
}

const noSubscribe = () => () => {}

export function FieldShell({
  children,
  className,
  help,
  htmlFor,
  label,
  path,
}: {
  children: React.ReactNode
  className?: string
  help?: React.ReactNode
  htmlFor?: string
  label: React.ReactNode
  path?: string
}) {
  const issue = useIssue(path)
  return (
    <div
      id={path === undefined ? undefined : fieldDomId(path)}
      className={cn("flex min-w-0 scroll-mt-40 flex-col gap-1.5", className)}
    >
      <label htmlFor={htmlFor} className="type-label">
        {label}
      </label>
      {children}
      {issue ? (
        <p className="type-meta text-destructive">{issue}</p>
      ) : help ? (
        <p className="type-meta text-muted-foreground">{help}</p>
      ) : null}
    </div>
  )
}

// A text field. With `optional`, clearing it removes the field.
export const TextField = React.memo(function TextField({
  className,
  help,
  label,
  mono,
  onChange,
  optional,
  path,
  placeholder,
  value,
}: {
  className?: string
  help?: React.ReactNode
  label: React.ReactNode
  mono?: boolean
  onChange: (value: string | undefined) => void
  optional?: boolean
  path: string
  placeholder?: string
  value: string | undefined
}) {
  const id = React.useId()
  const issue = useIssue(path)
  return (
    <FieldShell
      className={className}
      help={help}
      htmlFor={id}
      label={label}
      path={path}
    >
      <Input
        id={id}
        value={value ?? ""}
        placeholder={placeholder}
        aria-invalid={issue ? true : undefined}
        spellCheck={mono ? false : undefined}
        className={mono ? "font-mono text-sm" : undefined}
        onChange={(event) => {
          const next = event.target.value
          onChange(optional && next === "" ? undefined : next)
        }}
      />
    </FieldShell>
  )
})

export const NumberField = React.memo(function NumberField({
  className,
  help,
  label,
  onChange,
  path,
  placeholder,
  value,
}: {
  className?: string
  help?: React.ReactNode
  label: React.ReactNode
  onChange: (value: number | undefined) => void
  path: string
  placeholder?: string
  value: number | undefined
}) {
  const id = React.useId()
  const issue = useIssue(path)
  return (
    <FieldShell
      className={className}
      help={help}
      htmlFor={id}
      label={label}
      path={path}
    >
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={value ?? ""}
        placeholder={placeholder}
        aria-invalid={issue ? true : undefined}
        onChange={(event) => {
          const next = event.target.value
          onChange(next === "" ? undefined : Number(next))
        }}
      />
    </FieldShell>
  )
})

// A list edited as lines, one entry each. Keeps what's typed, blank lines
// included, until the list changes from somewhere else.
export const LinesField = React.memo(function LinesField({
  className,
  help,
  label,
  mono = true,
  onChange,
  path,
  placeholder,
  rows = 3,
  value,
}: {
  className?: string
  help?: React.ReactNode
  label: React.ReactNode
  mono?: boolean
  onChange: (value: Array<string> | undefined) => void
  path: string
  placeholder?: string
  rows?: number
  value: ReadonlyArray<string> | undefined
}) {
  const id = React.useId()
  const issue = useIssue(path)
  const [text, setText] = useSyncedText((value ?? []).join("\n"), (current) =>
    linesOf(current).join("\n")
  )
  return (
    <FieldShell
      className={className}
      help={help}
      htmlFor={id}
      label={label}
      path={path}
    >
      <Textarea
        id={id}
        rows={rows}
        value={text}
        placeholder={placeholder}
        spellCheck={mono ? false : undefined}
        aria-invalid={issue ? true : undefined}
        className={cn("min-h-0", mono && "font-mono text-sm")}
        onChange={(event) => {
          setText(event.target.value)
          const lines = linesOf(event.target.value)
          onChange(lines.length > 0 ? lines : undefined)
        }}
      />
    </FieldShell>
  )
})

function linesOf(text: string): Array<string> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

// Text typed in a field whose value is parsed from it: the field keeps the
// typed text while it still means the same value, and takes the value's own
// text when it changes from elsewhere, like the JSON.
export function useSyncedText(
  canonical: string,
  normalize: (text: string) => string
): [string, (text: string) => void] {
  const [text, setText] = React.useState(canonical)
  const current = normalize(text) === canonical ? text : canonical
  if (current !== text) setText(current)
  return [current, setText]
}

export const SwitchField = React.memo(function SwitchField({
  checked,
  help,
  label,
  onChange,
}: {
  checked: boolean
  help?: React.ReactNode
  label: React.ReactNode
  onChange: (checked: boolean) => void
}) {
  const id = React.useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="type-label">
          {label}
        </label>
        {help ? (
          <p className="type-meta mt-0.5 text-muted-foreground">{help}</p>
        ) : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
})

export function SelectField<T extends string>({
  className,
  help,
  label,
  onChange,
  options,
  path,
  value,
}: {
  className?: string
  help?: React.ReactNode
  label: React.ReactNode
  onChange: (value: T) => void
  options: ReadonlyArray<{ disabled?: boolean; label: string; value: T }>
  path?: string
  value: T | undefined
}) {
  const id = React.useId()
  return (
    <FieldShell
      className={className}
      help={help}
      htmlFor={id}
      label={label}
      path={path}
    >
      <Select value={value ?? ""} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose one" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  )
}

// Choices shown side by side, for a few options that each need a word.
export function Segmented<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string
  onChange: (value: T) => void
  options: ReadonlyArray<{
    disabled?: boolean
    icon?: React.ReactNode
    label: string
    value: T
  }>
  value: T
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid auto-cols-fr grid-flow-col gap-px border border-border bg-border"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className="type-control-sm flex h-9 items-center justify-center gap-1.5 bg-background px-2 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {option.icon}
          <span className="truncate">{option.label}</span>
        </button>
      ))}
    </div>
  )
}

export function SectionCard({
  actions,
  children,
  description,
  id,
  title,
}: {
  actions?: React.ReactNode
  children: React.ReactNode
  description?: React.ReactNode
  id: string
  title: React.ReactNode
}) {
  return (
    <section
      id={id}
      className="scroll-mt-36 border border-border bg-background"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="type-section-title">{title}</h2>
          {description ? (
            <p className="type-support mt-0.5 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions}
      </header>
      <div className="flex flex-col gap-5 p-5">{children}</div>
    </section>
  )
}

// A smaller heading inside a section.
export function Subheading({
  actions,
  children,
}: {
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
      <h3 className="type-technical-label text-muted-foreground">{children}</h3>
      {actions}
    </div>
  )
}
