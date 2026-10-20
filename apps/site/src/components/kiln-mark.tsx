import { cn } from "@workspace/ui/lib/utils"

import kilnLogo from "~/assets/kiln-logo.svg?url"

const kilnLogoMask = `url("${kilnLogo}")`

export function KilnMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-grid size-7 shrink-0 text-primary", className)}
    >
      <span
        className="size-full scale-[1.35] bg-current [mask-size:contain] [mask-position:center] [mask-repeat:no-repeat]"
        style={{ WebkitMaskImage: kilnLogoMask, maskImage: kilnLogoMask }}
      />
    </span>
  )
}
