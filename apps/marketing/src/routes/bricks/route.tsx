import { Outlet, createFileRoute } from "@tanstack/react-router"

import { Toaster } from "@workspace/ui/components/sonner"

// The Bricks pages copy and download, and say so in a toast.
export const Route = createFileRoute("/bricks")({
  component: BricksLayout,
})

function BricksLayout() {
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  )
}
