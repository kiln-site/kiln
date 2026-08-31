import * as React from "react"
import { Copy } from "lucide-react"

import { DropdownMenuItem } from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"

import { forkPromise } from "@/effect/promise"

export const CopyIdentifierMenuItem = React.memo(
  function CopyIdentifierMenuItem({
    label,
    value,
  }: {
    label: string
    value: string
  }) {
    const copyIdentifier = React.useCallback(() => {
      forkPromise(
        async () => {
          await navigator.clipboard.writeText(value)
          showToast({ message: `${label} copied`, type: "success" })
        },
        () =>
          showToast({
            message: `Could not copy ${label.toLowerCase()}`,
            type: "error",
          })
      )
    }, [label, value])

    return (
      <DropdownMenuItem onSelect={copyIdentifier}>
        <Copy /> Copy {label}
      </DropdownMenuItem>
    )
  }
)
