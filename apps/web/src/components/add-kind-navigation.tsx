import { cn } from "@workspace/ui/lib/utils"

import { addableKindNames, type AddableKind } from "@/components/brick-kinds"
import { instanceKindIcons } from "@/components/instance-kind-icon"

/** The Add dialog's choice of kind, shown when there's more than one. */
export function AddKindNavigation({
  disabled,
  kind,
  kinds,
  onKindChange,
}: {
  disabled: boolean
  kind: AddableKind
  kinds: ReadonlyArray<AddableKind>
  onKindChange: ((kind: AddableKind) => void) | undefined
}) {
  if (kinds.length <= 1 || !onKindChange) return null
  return (
    <>
      <p className="type-technical-label px-3 pt-3 pb-2 text-muted-foreground">
        Kind
      </p>
      <nav
        aria-label="Kind of instance"
        className="flex gap-1 overflow-x-auto border-b border-border/60 px-2 pb-2 md:flex-col"
      >
        {kinds.map((item) => {
          const presentation = addableKindNames[item]
          const Icon = instanceKindIcons[presentation.instanceKind]
          const active = item === kind
          return (
            <button
              key={item}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => {
                if (!active) onKindChange(item)
              }}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors duration-150",
                active
                  ? "bg-primary/12 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/55 hover:text-foreground",
                disabled && "pointer-events-none opacity-50"
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              {presentation.name}
            </button>
          )
        })}
      </nav>
    </>
  )
}
