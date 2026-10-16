import { createFileRoute, redirect } from "@tanstack/react-router"

// The Info page replaced Overview; old links land there.
export const Route = createFileRoute("/_app/app/$appId/overview")({
  beforeLoad: ({ params }) => {
    throw redirect({
      params: { appId: params.appId },
      replace: true,
      to: "/app/$appId/info",
    })
  },
})
