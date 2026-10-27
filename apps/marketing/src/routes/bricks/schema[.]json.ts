import { createFileRoute } from "@tanstack/react-router"

import { brickV2JsonSchema } from "@workspace/contracts"

// The kiln.brick/v2 JSON Schema, which Bricks name in `$schema`.
const schema = JSON.stringify(brickV2JsonSchema(), null, 2)

export const Route = createFileRoute("/bricks/schema.json")({
  server: {
    handlers: {
      GET: () =>
        new Response(schema, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=300",
            "Content-Type": "application/schema+json; charset=utf-8",
          },
        }),
    },
  },
})
