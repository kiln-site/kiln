import * as React from "react"
import { Link } from "@tanstack/react-router"

import { BrickTile } from "~/components/bricks/brick-glyph"
import { BrickKindIcon } from "~/components/bricks/kind-icon"
import {
  type ListedBrick,
  brickDeployLabels,
  brickKindLabels,
} from "~/lib/bricks"

export const BrickCard = React.memo(function BrickCard({
  listed,
}: {
  listed: ListedBrick
}) {
  const { brick } = listed
  return (
    <li className="group relative flex flex-col bg-background p-5 transition-colors hover:bg-card">
      <div className="flex items-start gap-4">
        <BrickTile color={brick.color} iconUrl={listed.iconUrl} id={brick.id} />
        <div className="min-w-0 flex-1">
          <h3 className="type-section-title truncate">
            <Link
              to="/bricks/$brickId"
              params={{ brickId: brick.id }}
              className="outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
            >
              {brick.name}
            </Link>
          </h3>
          <p className="type-meta mt-0.5 flex items-center gap-1.5 text-muted-foreground">
            <BrickKindIcon kind={brick.kind} className="size-3.5" />
            {brickKindLabels[brick.kind]}
            <span aria-hidden="true">·</span>
            {brickDeployLabels[brick.deploy.type]}
          </p>
        </div>
      </div>
      <p className="type-support mt-4 line-clamp-2 text-muted-foreground">
        {brick.summary}
      </p>
      <p className="type-meta mt-auto flex items-center justify-between gap-3 pt-4 text-muted-foreground">
        <span className="truncate">by {brick.author}</span>
        {listed.tier === "official" ? (
          <span className="type-label text-primary-ink">Official</span>
        ) : (
          <span className="type-label">Community</span>
        )}
      </p>
    </li>
  )
})
