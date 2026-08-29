import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_app/backups/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/backups/runs", search, replace: true })
  },
})
