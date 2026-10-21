import * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import {
  AppKindIcon,
  DatabaseKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"

import { BrickMark, officialBricks } from "~/components/brick-mark"
import { brandMarks, type BrandMarkDefinition } from "~/lib/brand-marks"

type Mark =
  | { kind: "brick"; color: string; icon: string; name: string }
  | { kind: "brand"; mark: BrandMarkDefinition; name: string }

const brand = (mark: BrandMarkDefinition): Mark => ({
  kind: "brand",
  mark,
  name: mark.title,
})

const groups: Array<{
  icon: React.ReactNode
  marks: Array<Mark>
  title: string
}> = [
  {
    icon: <ServerKindIcon className="size-4" />,
    marks: officialBricks.map((brick) => ({ kind: "brick", ...brick })),
    title: "Game servers",
  },
  {
    icon: <AppKindIcon className="size-4" />,
    marks: [brand(brandMarks.github), brand(brandMarks.docker)],
    title: "Apps",
  },
  {
    icon: <DatabaseKindIcon className="size-4" />,
    marks: [
      brand(brandMarks.mysql),
      brand(brandMarks.mariadb),
      brand(brandMarks.postgres),
      brand(brandMarks.redis),
      brand(brandMarks.valkey),
    ],
    title: "Databases",
  },
  {
    icon: <BrandSvg mark={brandMarks.cloudflare} className="size-4" />,
    marks: [brand(brandMarks.cloudflare)],
    title: "Domains",
  },
]

// What Kiln runs, as the marks of what it runs: the Bricks game servers
// start from, where apps deploy from, the database engines, and the DNS
// Kiln writes game server addresses to.
export function KindsSection() {
  return (
    <div className="mt-14 grid gap-px border border-border bg-border md:grid-cols-[5fr_2fr]">
      {groups.map((group) => (
        <section
          key={group.title}
          aria-label={group.title}
          className="flex flex-col bg-background"
        >
          <h3 className="type-label flex items-center gap-2 px-4 py-3 text-muted-foreground">
            {group.icon}
            {group.title}
          </h3>
          <ul
            className={cn(
              "grid grid-cols-5 border-t border-border",
              group.marks.length === 2 && "md:grid-cols-2",
              group.marks.length === 1 && "md:grid-cols-1"
            )}
          >
            {group.marks.map((mark) => (
              <MarkTile key={mark.name} mark={mark} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function MarkTile({ mark }: { mark: Mark }) {
  const color = mark.kind === "brick" ? mark.color : mark.mark.color
  return (
    <li className="aspect-square border-r border-border last:border-r-0 md:aspect-auto md:h-36 lg:h-44">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={mark.name}
            tabIndex={0}
            className="grid size-full place-items-center text-foreground transition-colors outline-none hover:bg-[color-mix(in_oklab,var(--mark)_9%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--mark)_9%,transparent)]"
            style={
              {
                "--mark": color === "currentColor" ? "white" : color,
              } as React.CSSProperties
            }
          >
            {mark.kind === "brick" ? (
              <span style={{ color: mark.color }}>
                <BrickMark
                  icon={mark.icon}
                  className="block size-7 sm:size-10"
                />
              </span>
            ) : (
              <BrandSvg mark={mark.mark} className="size-7 sm:size-10" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {mark.name}
        </TooltipContent>
      </Tooltip>
    </li>
  )
}

function BrandSvg({
  className,
  mark,
}: {
  className: string
  mark: BrandMarkDefinition
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox={mark.viewBox}
      fill={mark.color}
      className={cn("shrink-0", className)}
    >
      <path d={mark.path} fillRule={mark.fillRule} />
    </svg>
  )
}
