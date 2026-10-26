import * as React from "react"

import { Button } from "@workspace/ui/components/button"

// Pieces form dialogs share: a choice between modes, shown as two buttons,
// and a labeled field.

export function ModeButton({
  checked,
  description,
  disabled,
  icon,
  label,
  onSelect,
}: {
  checked: boolean
  description: string
  disabled: boolean
  icon: React.ReactNode
  label: string
  onSelect: () => void
}) {
  return (
    <Button
      aria-checked={checked}
      className="h-auto min-w-0 items-start justify-start px-3 py-2.5 text-left whitespace-normal"
      disabled={disabled}
      role="radio"
      type="button"
      variant={checked ? "default" : "outline"}
      onClick={onSelect}
    >
      <span className="mt-0.5 [&_svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs">{label}</span>
        <span className="type-meta mt-0.5 block">{description}</span>
      </span>
    </Button>
  )
}

export function Field({
  children,
  label,
}: {
  children: React.ReactNode
  label: React.ReactNode
}) {
  return (
    <label className="type-label grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
      {label}
      {children}
    </label>
  )
}
