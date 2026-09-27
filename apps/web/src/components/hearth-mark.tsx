import { cn } from "@workspace/ui/lib/utils"

import kilnLogo from "@/assets/branding/kiln-logo.svg?url"

const kilnLogoMask = `url("${kilnLogo}")`

export function HearthMark({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative grid size-8 shrink-0 place-items-center text-primary",
        className
      )}
    >
      <span
        className="size-full scale-[1.35] bg-current [mask-size:contain] [mask-position:center] [mask-repeat:no-repeat]"
        style={{ WebkitMaskImage: kilnLogoMask, maskImage: kilnLogoMask }}
      />
    </div>
  )
}
