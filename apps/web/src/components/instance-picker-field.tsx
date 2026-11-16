import * as React from "react"
import { ChevronsUpDown, Plus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import { IdentityName } from "@/components/identity-name"
import type {
  InstancePickerIdentity,
  InstancePickerItem,
} from "@/lib/instance-picker-filters"

// One field of a form that picks with the instance picker: a trigger showing
// what's chosen, as a card, over the searchable list. Typing can offer to
// create what isn't there yet (`pickerCreateItem`), as a volume, a database
// or a tunnel does.

export function InstancePickerField({
  children,
  disabled = false,
  focusAfterChoice,
  keepFocus = false,
  label,
  labelClassName = "mb-2 block text-xs font-medium",
  title,
  value,
}: {
  /** The picker, given what closes it once something is chosen. */
  children: (close: () => void) => React.ReactNode
  disabled?: boolean
  /** Takes focus once a choice closes the picker. */
  focusAfterChoice?: React.RefObject<HTMLElement | null>
  /** Something else, such as a dialog the choice opened, keeps the focus. */
  keepFocus?: boolean
  label: string
  labelClassName?: string
  /** What the list is called, as a drawer's title on a phone. */
  title: string
  /** What's chosen, on the trigger: a card, always the same height. */
  value: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const chose = React.useRef(false)
  const close = React.useCallback(() => {
    chose.current = true
    setOpen(false)
  }, [])
  return (
    <div className="min-w-0">
      <span className={labelClassName}>{label}</span>
      <DrawerPopover open={open} onOpenChange={setOpen}>
        <DrawerPopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={label}
            disabled={disabled}
            className="h-12 w-full justify-between gap-3 px-2 font-normal"
          >
            {value}
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DrawerPopoverTrigger>
        <DrawerPopoverContent
          title={title}
          align="start"
          className="z-[70] w-(--radix-popover-trigger-width) min-w-72 overflow-hidden p-0"
          onCloseAutoFocus={(event) => {
            if (keepFocus) {
              event.preventDefault()
              return
            }
            if (!chose.current) return
            chose.current = false
            if (!focusAfterChoice) return
            event.preventDefault()
            focusAfterChoice.current?.focus()
          }}
        >
          {children(close)}
        </DrawerPopoverContent>
      </DrawerPopover>
    </div>
  )
}

/** A picker row's card for what isn't an instance: an icon over two lines. */
export function PickerCard({
  icon,
  meta,
  metaClassName = "font-mono",
  name,
  nameAccessory,
  textClassName,
}: {
  icon: React.ReactNode
  meta: React.ReactNode
  metaClassName?: string | undefined
  name: string
  nameAccessory?: React.ReactNode
  textClassName?: string | undefined
}) {
  return (
    <IdentityName
      className="min-w-0 flex-1 gap-2 text-left"
      icon={icon}
      iconClassName="border-0 bg-muted/55"
      meta={meta}
      metaClassName={metaClassName}
      name={name}
      nameAccessory={nameAccessory}
      nameClassName="type-control-sm"
      textClassName={textClassName}
    />
  )
}

/**
 * The row offering to create what's typed, listed after the matches so Enter
 * reaches it once none are left. Its `searchText` is the name typed.
 */
export function pickerCreateItem<Identity extends InstancePickerIdentity>({
  identity,
  meta,
  name,
}: {
  identity: Identity
  /** What creating it makes, such as "New volume on this Relay". */
  meta: string
  name: string
}): InstancePickerItem<Identity> {
  return {
    card: (
      <PickerCard
        icon={<Plus className="size-4 text-primary-ink" aria-hidden="true" />}
        meta={meta}
        metaClassName={undefined}
        name={`Create ${name}`}
      />
    ),
    identity,
    key: identity.id,
    meta: "",
    name,
    searchText: name,
  }
}

/** The trigger's card while nothing is chosen, or for what's to be made. */
export function PickerPlaceholder({
  icon,
  meta,
  name,
}: {
  icon: React.ReactNode
  meta: string
  name: string
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/55">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="type-control-sm block truncate">{name}</span>
        <span className="type-meta block truncate text-muted-foreground">
          {meta}
        </span>
      </span>
    </span>
  )
}
