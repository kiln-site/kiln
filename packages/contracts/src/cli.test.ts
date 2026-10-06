import { describe, expect, it } from "vite-plus/test"

import {
  cliActivityEntrySchema,
  cliCreateServerRequestSchema,
  cliServerInfoResponseSchema,
  cliServerSchema,
  cliUpdateServerStartupRequestSchema,
} from "./cli"
import {
  MAXIMUM_INSTANCE_NAME_LENGTH,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
} from "./instance-limits"

describe("CLI API request limits", () => {
  it("enforces the Relay disk minimum", () => {
    const diskLimitBytes = MINIMUM_INSTANCE_DISK_LIMIT_BYTES - 1
    expect(
      cliCreateServerRequestSchema.safeParse({
        brick: "paper",
        diskLimitBytes,
        name: "Survival",
        relayId: "r".repeat(43),
        start: true,
        variables: {},
      }).success
    ).toBe(false)
    expect(
      cliUpdateServerStartupRequestSchema.safeParse({
        diskLimitBytes,
        instanceId: "a".repeat(40),
        relayId: "r".repeat(43),
        start: true,
        variables: {},
      }).success
    ).toBe(false)
  })

  it("enforces the server-name maximum for new servers", () => {
    const input = {
      brick: "paper",
      diskLimitBytes: MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
      name: "a".repeat(MAXIMUM_INSTANCE_NAME_LENGTH),
      relayId: "r".repeat(43),
      start: true,
      variables: {},
    }
    expect(cliCreateServerRequestSchema.safeParse(input).success).toBe(true)
    expect(
      cliCreateServerRequestSchema.safeParse({
        ...input,
        name: `${input.name}a`,
      }).success
    ).toBe(false)
  })
})

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
