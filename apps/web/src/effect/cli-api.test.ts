import { assert, describe, it } from "@effect/vitest"
import {
  cliBrickReferenceSchema,
  cliRemoteFileUploadRequestSchema,
  cliServerInfoResponseSchema,
} from "@workspace/contracts"

import { safeCliBrickSource } from "@/effect/cli-api"

describe("CLI response and URL boundaries", () => {
  it("rejects insecure URLs and paths that escape the server root", () => {
    const target = {
      instanceId: "a".repeat(40),
      relayId: "r".repeat(43),
    }
    assert.isFalse(
      cliRemoteFileUploadRequestSchema.safeParse({
        ...target,
        path: "plugins/example.jar",
        url: "http://example.com/example.jar",
      }).success
    )
    assert.isFalse(
      cliRemoteFileUploadRequestSchema.safeParse({
        ...target,
        path: "../example.jar",
        url: "https://example.com/example.jar",
      }).success
    )
    assert.isFalse(
      cliRemoteFileUploadRequestSchema.safeParse({
        ...target,
        path: "plugins/example.jar",
        url: "https://user:password@example.com/example.jar",
      }).success
    )
    assert.isFalse(
      cliBrickReferenceSchema.safeParse(
        "https://user:password@example.com/paper.yml"
      ).success
    )
  })

  it("keeps server variables and internal runtime fields out of metadata", () => {
    const response = {
      relay: { id: "r".repeat(43), name: "Relay" },
      server: {
        brickId: "paper",
        brickSource: "https://example.com/paper.yml",
        connectAddress: "play.example.com",
        desiredState: "running",
        diskLimitBytes: 1024,
        game: "Minecraft",
        id: "a".repeat(40),
        implementation: "paper",
        javaVersion: "21",
        memoryLimitBytes: 1024,
        name: "Survival",
        observedState: "running",
        stateReason: {
          code: "automatic_recovery",
          exitCode: 137,
          phase: "restarting",
          reason: "process_exit",
        },
        publicAddress: "play.example.com:25565",
        lifecycle: [],
        resources: null,
        shortId: "a".repeat(8),
        version: "1.21.11",
      },
    }
    const serialized = cliServerInfoResponseSchema.parse(response)
    assert.deepStrictEqual(serialized.server.stateReason, {
      code: "automatic_recovery",
      exitCode: 137,
      phase: "restarting",
      reason: "process_exit",
    })
    assert.isFalse(
      cliServerInfoResponseSchema.safeParse({
        ...response,
        server: {
          ...response.server,
          directory: "/data/private",
          variables: { secret: "value" },
        },
      }).success
    )
  })

  it("removes credentials and query secrets from Brick metadata", () => {
    assert.strictEqual(
      safeCliBrickSource(
        "https://user:password@example.com/paper.yml?token=secret#fragment"
      ),
      "https://example.com/paper.yml"
    )
  })
})
