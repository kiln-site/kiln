import { createFileRoute } from "@tanstack/react-router"

import { BrickCreator } from "~/components/bricks/creator/brick-creator"
import { findListedBrick } from "~/lib/bricks"
import { pageHead } from "~/lib/seo"

export const Route = createFileRoute("/bricks/new")({
  // `from` opens a copy of a listed Brick instead of the start screen.
  validateSearch: (search: Record<string, unknown>): { from?: string } =>
    typeof search.from === "string" && findListedBrick(search.from)
      ? { from: search.from }
      : {},
  head: ({ matches }) =>
    pageHead({
      description:
        "Build a Kiln Brick in your browser: see the install form it makes and the JSON it writes as you go.",
      matches,
      path: "/bricks/new",
      title: "Create a Brick | Kiln",
    }),
  component: CreateBrickPage,
})

function CreateBrickPage() {
  const { from } = Route.useSearch()
  return (
    <BrickCreator key={from ?? ""} from={findListedBrick(from ?? "")?.brick} />
  )
}
