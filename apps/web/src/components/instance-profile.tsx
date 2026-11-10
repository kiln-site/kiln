import * as React from "react"

import { InfoCopyValue } from "@/components/info-page"

// What an instance is, the same for every kind: on the left its icon, name,
// and Kiln ID with Favorite, and on the right the Brick it runs with what
// configures it, split where the facts below split. What its Brick deploys
// follows, the facts that matter to it.
export function InstanceProfile({
  brick,
  brickAction,
  children,
  favorite,
  icon,
  id,
  idLabel,
  name,
  rename,
}: {
  /** The Brick it runs, as one line. */
  brick: React.ReactNode
  /** What opens the Brick's settings, for whoever may change them. */
  brickAction?: React.ReactNode
  /** Its Brick's facts, as `InfoFact`s. */
  children?: React.ReactNode
  favorite: React.ReactNode
  icon: React.ReactNode
  id: string
  // Lowercase noun, for example "server ID".
  idLabel: string
  name: string
  rename?: React.ReactNode
}) {
  return (
    <section className="min-w-0 border bg-background/45">
      <div className="@container px-4">
        <div className="grid @lg:grid-cols-2 @lg:gap-x-8">
          <div className="flex min-w-0 items-center gap-4 py-4">
            {icon}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1">
                <h3
                  className="truncate font-heading text-lg font-semibold tracking-[-0.02em]"
                  title={name}
                >
                  {name}
                </h3>
                {rename}
              </div>
              <div className="type-meta mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span className="shrink-0">Kiln ID</span>
                <InfoCopyValue
                  className="text-muted-foreground"
                  label={idLabel}
                  value={id}
                />
              </div>
            </div>
            {favorite}
          </div>
          {/* The divider sits in the gap, so each half lines up with the
              facts under it. */}
          <div className="flex min-w-0 items-center gap-4 border-t border-border/60 py-4 @lg:-ml-4 @lg:border-t-0 @lg:border-l @lg:pl-4">
            <div className="min-w-0 flex-1">
              <p className="type-technical-label text-muted-foreground/80 light:text-muted-foreground/90">
                Brick
              </p>
              {brick}
            </div>
            {brickAction}
          </div>
        </div>
      </div>
      {children == null ? null : (
        <dl className="@container border-t px-4">{children}</dl>
      )}
    </section>
  )
}

/** The Brick's line in a profile: what it is, behind its icon. */
export function InstanceProfileBrick({
  children,
  icon,
}: {
  children: React.ReactNode
  icon: React.ReactNode
}) {
  return (
    <p className="mt-1 flex h-5 min-w-0 items-center gap-1.5 text-sm font-medium [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
      {icon}
      <span className="truncate">{children}</span>
    </p>
  )
}
