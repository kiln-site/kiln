import * as React from "react"
import { ArrowDown, Globe, Plus } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import {
  AppKindIcon,
  DatabaseKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"

import { BrickMark, officialBricks } from "~/components/brick-mark"
import { brandMarks, type BrandMarkDefinition } from "~/lib/brand-marks"

// What Kiln runs, one card each: a picture of the idea, then a line on it.
// The pictures are illustrations, not Hearth's screens.
export function KindsSection() {
  return (
    <div className="mt-14 grid gap-px border border-border bg-border lg:grid-cols-2">
      <Card
        icon={<ServerKindIcon className="size-4" />}
        kind="Game servers"
        title="Start from a Brick"
        visual={<BrickWall />}
      >
        Pick Paper, Fabric, Palworld, or a Brick of your own. Kiln sets up the
        ports and the right Java.
      </Card>
      <Card
        icon={<AppKindIcon className="size-4" />}
        kind="Apps"
        title="Push, and it's live"
        visual={<DeployFlow />}
      >
        Deploy a GitHub repository or a Docker image. New containers take over
        once they're healthy, on your own domain.
      </Card>
      <Card
        icon={<DatabaseKindIcon className="size-4" />}
        kind="Databases"
        title="A database next door"
        visual={<EngineOrbit />}
      >
        MySQL, MariaDB, PostgreSQL, Redis, or Valkey, on the same machine as the
        app or server that uses it.
      </Card>
      <Card
        icon={<BrandSvg mark={brandMarks.cloudflare} className="size-4" />}
        kind="Domains"
        title="Addresses players remember"
        visual={<VanityAddress />}
      >
        Connect Cloudflare and each game server gets its own name. Kiln writes
        the DNS records, port included.
      </Card>
    </div>
  )
}

function Card({
  children,
  icon,
  kind,
  title,
  visual,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  kind: string
  title: string
  visual: React.ReactNode
}) {
  return (
    <article className="flex flex-col bg-background">
      <div
        aria-hidden="true"
        className="relative h-64 overflow-hidden border-b border-border sm:h-80"
      >
        <div className="absolute inset-0 bg-[image:var(--ambient-grid)] [mask-image:radial-gradient(ellipse_70%_70%_at_50%_50%,black,transparent)] bg-[size:32px_32px] opacity-60" />
        {visual}
      </div>
      <div className="p-6 sm:p-8">
        <p className="type-label flex items-center gap-2 text-muted-foreground">
          {icon}
          {kind}
        </p>
        <h3 className="mt-3 font-heading text-2xl font-semibold tracking-[-0.035em]">
          {title}
        </h3>
        <p className="site-copy mt-2 max-w-md text-muted-foreground">
          {children}
        </p>
      </div>
    </article>
  )
}

// A glow of one colour behind a picture.
function Glow({ className, color }: { className?: string; color: string }) {
  return (
    <div
      className={cn("absolute inset-0", className)}
      style={{
        background: `radial-gradient(ellipse 55% 45% at 50% 55%, color-mix(in oklab, ${color} 22%, transparent), transparent)`,
      }}
    />
  )
}

type Brick = (typeof officialBricks)[number]
const bricks = Object.fromEntries(
  officialBricks.map((brick) => [brick.name, brick])
) as Record<Brick["name"], Brick>

// Bricks laid as a wall, the official ones lit. Rows alternate seven and
// six bricks, so centring them offsets each by half a brick, as a wall is.
const wall: Array<Array<Brick["name"] | "own" | null>> = [
  [null, null, null, null, null, null, null],
  [null, null, "Paper", "Fabric", null, null],
  [null, null, "Velocity", "Folia", "Palworld", null, null],
  [null, null, "own", null, null, null],
]

function BrickWall() {
  return (
    <>
      <Glow color="var(--primary)" className="translate-y-1/4" />
      <div className="absolute inset-0 flex items-center justify-center [mask-image:radial-gradient(ellipse_75%_80%_at_50%_50%,black_40%,transparent)]">
        <div className="flex shrink-0 flex-col items-center gap-2 max-sm:scale-[0.78]">
          {wall.map((row, index) => (
            <div key={index} className="flex shrink-0 gap-2">
              {row.map((name, column) => (
                <WallBrick key={column} name={name} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function WallBrick({ name }: { name: Brick["name"] | "own" | null }) {
  const base = "flex h-14 w-34 shrink-0 items-center gap-2.5 px-3.5 sm:h-16"
  if (name === null) {
    return <div className={cn(base, "border border-border/70 bg-card/50")} />
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
  const brick = bricks[name]
  return (
    <div
      className={cn(base, "border")}
      style={{
        backgroundColor: `color-mix(in oklab, ${brick.color} 13%, var(--background))`,
        borderColor: `color-mix(in oklab, ${brick.color} 45%, transparent)`,
        boxShadow: `0 0 40px -12px ${brick.color}`,
        color: brick.color,
      }}
    >
      <BrickMark icon={brick.icon} className="size-6" />
      <span className="text-sm font-medium text-foreground">{brick.name}</span>
    </div>
  )
}

// A push travels from GitHub through a build to the app's address.
function DeployFlow() {
  return (
    <>
      <Glow color={brandMarks.docker.color} />
      <div className="absolute inset-0 flex items-center justify-center px-10 sm:px-16">
        <div className="flex w-full max-w-md items-start">
          <FlowNode label="git push">
            <BrandSvg mark={brandMarks.github} className="size-8" />
          </FlowNode>
          <FlowLine delay="0s" />
          <FlowNode label="Build">
            <BrandSvg mark={brandMarks.docker} className="size-9" />
          </FlowNode>
          <FlowLine delay="-1.2s" />
          <FlowNode label="shop.example.com" highlight>
            <Globe className="size-8 text-primary" />
          </FlowNode>
        </div>
      </div>
    </>
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
    <div className="flex w-14 shrink-0 flex-col items-center gap-3 sm:w-20">
      <div
        className={cn(
          "grid size-14 place-items-center border bg-card sm:size-20",
          highlight
            ? "border-primary/50 shadow-[0_0_48px_-12px_var(--primary)]"
            : "border-border"
        )}
      >
        {children}
      </div>
      <span
        className={cn(
          "type-meta font-mono whitespace-nowrap",
          highlight ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
      </span>
    </div>
  )
}

function FlowLine({ delay }: { delay: string }) {
  return (
    <div className="relative mt-7 h-px flex-1 overflow-hidden bg-border sm:mt-10">
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
function EngineOrbit() {
  return (
    <>
      <Glow color={brandMarks.postgres.color} />
      <div className="absolute inset-0 grid place-items-center">
        <div className="relative size-48 sm:size-56">
          <div className="absolute inset-0 rounded-full border border-dashed border-border" />
          <div className="absolute inset-[34%] grid place-items-center border border-border bg-card shadow-[0_0_48px_-16px_var(--primary)]">
            <AppKindIcon className="size-8" />
          </div>
          {engines.map((mark, index) => {
            const angle = (index / engines.length) * 2 * Math.PI - Math.PI / 2
            return (
              <div
                key={mark.title}
                className="absolute grid size-14 -translate-1/2 place-items-center border border-border bg-card sm:size-16"
                style={{
                  left: `${50 + 50 * Math.cos(angle)}%`,
                  top: `${50 + 50 * Math.sin(angle)}%`,
                  boxShadow: `0 0 36px -14px ${mark.color === "currentColor" ? "white" : mark.color}`,
                }}
              >
                <BrandSvg mark={mark} className="size-7 sm:size-8" />
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

// An address nobody remembers becomes one they do.
function VanityAddress() {
  return (
    <>
      <Glow color={brandMarks.cloudflare.color} />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
        <span className="font-mono text-base text-muted-foreground line-through decoration-muted-foreground/60 sm:text-lg">
          203.0.113.24:25565
        </span>
        <ArrowDown className="size-4 text-muted-foreground" />
        <span className="flex items-center gap-3 font-mono text-2xl tracking-[-0.03em] text-foreground sm:text-4xl">
          <BrandSvg
            mark={brandMarks.cloudflare}
            className="size-8 sm:size-10"
          />
          smp.example.com
        </span>
      </div>
    </>
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
