import { describe, expect, it } from "vite-plus/test"

import {
  cliActivityEntrySchema,
  cliServerInfoResponseSchema,
  cliServerSchema,
} from "./cli"

describe("CLI API responses", () => {
  it("keeps server names created before the name limit readable", () => {
    const name = "a".repeat(120)

    expect(cliServerSchema.shape.name.safeParse(name).success).toBe(true)
    expect(
      cliServerInfoResponseSchema.shape.server.shape.name.safeParse(name)
        .success
    ).toBe(true)
    expect(
      cliActivityEntrySchema.safeParse({
        actor: { email: null, id: "user", name: "User" },
        id: "activity",
        label: "Server created",
        occurredAt: Date.now(),
        permission: "instance.create",
        relay: { id: "relay", name: "Relay" },
        server: { id: "server", name },
        source: "cli",
        type: "server",
      }).success
    ).toBe(true)
  })
})
