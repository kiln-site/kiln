import * as React from "react"
import { Link } from "@tanstack/react-router"
import {
  ArrowDown,
  Axe,
  Bone,
  Castle,
  Cog,
  Factory,
  Gem,
  Globe,
  Plus,
  Swords,
  TreePine,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import {
  AppKindIcon,
  DatabaseKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import { BRICK_COLOR_PALETTE } from "@/components/brick-icon"

import { BrickMark, officialBricks } from "~/components/brick-mark"
import { KilnMark } from "~/components/kiln-mark"
import { BrandSvg } from "~/components/brand-svg"
import { brandMarks } from "~/lib/brand-marks"

// What Kiln runs, one card each: a picture of the idea, then a line on it.
// The pictures are illustrations, not Hearth's screens.
export function KindsSection() {
  return (
    <>
      <div className="mt-12 grid gap-px border border-border bg-border lg:grid-cols-2">
        <Card
          icon={<ServerKindIcon className="size-6" />}
          title="Game servers"
          visual={<BrickWall />}
        >
          Start from a Brick
          <Link
            to="."
            hash="kinds-note"
            resetScroll={false}
            aria-label="See note"
            className="text-foreground no-underline"
          >
            *
          </Link>
          . Kiln handles the rest.
        </Card>
        <Card
          icon={<AppKindIcon className="size-6" />}
          title="Apps"
          visual={<DeployFlow />}
        >
          Kiln builds and deploys on every push with zero downtime.
        </Card>
        <Card
          icon={<DatabaseKindIcon className="size-6" />}
          title="Databases"
          visual={<EngineRing />}
        >
          MySQL, Postgres, Redis, and more.
        </Card>
        <Card
          icon={<BrandSvg mark={brandMarks.cloudflare} className="size-6" />}
          title="Domains and Auto SSL"
          visual={<VanityAddress />}
        >
          Connect Cloudflare and your DNS is set up automatically.
        </Card>
      </div>
      <p
        id="kinds-note"
        className="type-meta mx-auto mt-5 max-w-4xl text-center text-balance text-muted-foreground/70"
      >
        * Kiln isn't affiliated with or endorsed by any game, studio, or company
        shown, including Mojang and Microsoft. All trademarks belong to their
        owners.
      </p>
    </>
  )
}

function Card({
  children,
  icon,
  title,
  visual,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  title: string
  visual: React.ReactNode
}) {
  return (
    <article className="flex flex-col bg-background">
      <div
        aria-hidden="true"
        className="relative h-56 overflow-hidden border-b border-border sm:h-64"
      >
        {/* The hero's grid and warmth, fainter. */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_50%_0%,hsl(var(--accent-hue)_var(--accent-saturation)_58%/0.07),transparent)]" />
        <div className="absolute inset-0 bg-[image:var(--ambient-grid)] [mask-image:radial-gradient(ellipse_80%_70%_at_50%_0%,black,transparent)] bg-[size:32px_32px]" />
        {visual}
      </div>
      <div className="p-6 sm:px-8 sm:py-7">
        <h3 className="flex items-center gap-3 font-heading text-2xl font-semibold tracking-[-0.035em]">
          {icon}
          {title}
        </h3>
        <p className="site-copy mt-2 text-muted-foreground">{children}</p>
      </div>
    </article>
  )
}

type Brick = (typeof officialBricks)[number]
const bricks = Object.fromEntries(
  officialBricks.map((brick) => [brick.name, brick])
) as Record<Brick["name"], Brick>

// Games the wall shows that have no Brick yet. Their marks are stand-ins
// until each has a Brick and an icon of its own.
const upcoming = {
  Rust: { color: "#cd5a3c", icon: Axe },
  Valheim: { color: "#c9a45c", icon: Swords },
  ARK: { color: "#5bb3a8", icon: Bone },
  Terraria: { color: "#8fbf4a", icon: TreePine },
  Hytale: { color: "#5b9bd5", icon: Castle },
  Factorio: { color: "#e39827", icon: Cog },
  Satisfactory: { color: "#e0b43c", icon: Factory },
  "Core Keeper": { color: "#9b7be0", icon: Gem },
} satisfies Record<string, { color: string; icon: LucideIcon }>

type WallSlot = Brick["name"] | keyof typeof upcoming | "own" | null

// Bricks laid as a wall. Rows alternate seven and six bricks, so centring
// them offsets each by half a brick, as a wall is. The best-known games sit
// nearest the middle, where the wall doesn't fade.
const wall: Array<Array<WallSlot>> = [
  [null, null, "Satisfactory", "Rust", "Core Keeper", null, null],
  [null, "Hytale", "Paper", "Fabric", "Valheim", null],
  [null, null, "Velocity", "own", "Palworld", null, null],
  [null, "Factorio", "Folia", "ARK", "Terraria", null],
]

function BrickWall() {
  return (
    <div className="absolute inset-0 flex items-center justify-center [mask-image:radial-gradient(ellipse_75%_80%_at_50%_50%,black_45%,transparent)]">
      <div className="flex shrink-0 flex-col items-center gap-2 max-sm:scale-[0.78]">
        {wall.map((row, index) => (
          <div key={index} className="flex shrink-0 gap-2">
            {row.map((name, column) => (
              <WallBrick
                key={column}
                name={name}
                tint={
                  BRICK_COLOR_PALETTE[
                    (index * 4 + column * 7) % BRICK_COLOR_PALETTE.length
                  ]!
                }
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// An empty brick takes `tint` for its border, so the wall's edges read as
// more Bricks rather than blanks.
function WallBrick({ name, tint }: { name: WallSlot; tint: string }) {
  const base = "flex h-14 w-36 shrink-0 items-center gap-2 px-3"
  if (name === null) {
    return (
      <div
        className={cn(base, "border bg-card/60")}
        style={{
          borderColor: `color-mix(in oklab, ${tint} 35%, transparent)`,
        }}
      />
    )
  }
  if (name === "own") {
    return (
      <div
        className={cn(
          base,
          "border border-dashed border-muted-foreground/40 text-muted-foreground"
        )}
      >
        <Plus className="size-5" />
        <span className="text-sm font-medium">Your own</span>
      </div>
    )
  }
  const game = name in upcoming ? upcoming[name as keyof typeof upcoming] : null
  const color = game ? game.color : bricks[name as Brick["name"]].color
  return (
    <div
      className={cn(base, "border bg-card")}
      style={{
        borderColor: `color-mix(in oklab, ${color} 40%, transparent)`,
        color,
      }}
    >
      {game ? (
        <game.icon className="size-6 shrink-0" />
      ) : (
        <BrickMark
          icon={bricks[name as Brick["name"]].icon}
          className="size-6"
        />
      )}
      <span className="truncate text-sm font-medium text-foreground">
        {name}
      </span>
    </div>
  )
}

// A push travels from GitHub to Kiln, which builds it and deploys it.
function DeployFlow() {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-10 sm:px-16">
      <div className="flex w-full max-w-md items-start">
        <FlowNode label="Push">
          <BrandSvg mark={brandMarks.github} className="size-7" />
        </FlowNode>
        <FlowLine delay="0s" />
        <FlowNode label="Build" highlight>
          <KilnMark className="size-8" />
        </FlowNode>
        <FlowLine delay="-1.2s" />
        <FlowNode label="Deploy">
          <Globe className="size-7 text-foreground" />
        </FlowNode>
      </div>
    </div>
  )
}

function FlowNode({
  children,
  highlight,
  label,
}: {
  children: React.ReactNode
  highlight?: boolean
  label: string
}) {
  return (
    <div className="flex w-14 shrink-0 flex-col items-center gap-3 sm:w-18">
      <div
        className={cn(
          "grid size-14 place-items-center border bg-card sm:size-18",
          highlight ? "border-primary/50" : "border-border"
        )}
      >
        {children}
      </div>
      <span className="type-meta text-muted-foreground">{label}</span>
    </div>
  )
}

function FlowLine({ delay }: { delay: string }) {
  return (
    <div className="relative mt-7 h-px flex-1 overflow-hidden bg-border sm:mt-9">
      <div
        className="absolute inset-0 bg-[linear-gradient(90deg,transparent_0%,var(--primary)_50%,transparent_100%)] bg-[length:35%_100%] bg-no-repeat motion-safe:animate-[site-flow_2.4s_ease-in-out_infinite] motion-reduce:hidden"
        style={{ animationDelay: delay }}
      />
    </div>
  )
}

const engines = [
  brandMarks.mysql,
  brandMarks.mariadb,
  brandMarks.postgres,
  brandMarks.redis,
  brandMarks.valkey,
]

// The engines in a ring around the app that uses them.
function EngineRing() {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="relative size-40 translate-y-2 sm:size-44">
        <div className="absolute inset-0 rounded-full border border-dashed border-border" />
        <div className="absolute inset-[34%] grid place-items-center border border-border bg-card">
          <AppKindIcon className="size-6" />
        </div>
        {engines.map((mark, index) => {
          const angle = (index / engines.length) * 2 * Math.PI - Math.PI / 2
          return (
            <div
              key={mark.title}
              className="absolute grid size-12 -translate-1/2 place-items-center border border-border bg-card sm:size-14"
              style={{
                left: `${50 + 50 * Math.cos(angle)}%`,
                top: `${50 + 50 * Math.sin(angle)}%`,
              }}
            >
              <BrandSvg mark={mark} className="size-6 sm:size-7" />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// An address nobody remembers becomes one they do.
function VanityAddress() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
      <span className="font-mono text-base text-muted-foreground line-through decoration-muted-foreground/60">
        203.0.113.24:25565
      </span>
      <ArrowDown className="size-4 text-muted-foreground" />
      <span className="flex items-center gap-3 font-mono text-2xl tracking-[-0.03em] text-foreground sm:text-3xl">
        <BrandSvg mark={brandMarks.cloudflare} className="size-7 sm:size-9" />
        smp.example.com
      </span>
    </div>
  )
}
