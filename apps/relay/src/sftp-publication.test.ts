import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { relaySnapshotSchema } from "@workspace/contracts"

import {
  inspectRelaySftpPublicationEffect,
  relaySftpPublicationFromBindings,
} from "./docker.js"

describe("Relay SFTP publication", () => {
  it("reports a missing Docker port binding", () => {
    assert.deepEqual(relaySftpPublicationFromBindings({}, 2022), {
      port: 2022,
      status: "not_published",
    })
  })

  it("reports a loopback-only Docker port binding", () => {
    assert.deepEqual(
      relaySftpPublicationFromBindings(
        {
          "2022/tcp": [
            { HostIp: "127.0.0.1", HostPort: "32022" },
            { HostIp: "::1", HostPort: "32022" },
          ],
        },
        2022
      ),
      { port: 32_022, status: "loopback_only" }
    )
  })

  it("uses the externally remapped Docker host port", () => {
    assert.deepEqual(
      relaySftpPublicationFromBindings(
        {
          "2022/tcp": [
            { HostIp: "127.0.0.1", HostPort: "32021" },
            { HostIp: "0.0.0.0", HostPort: "32022" },
          ],
        },
        2022
      ),
      { port: 32_022, status: "published" }
    )
  })

  it.effect("falls back to unknown when Docker inspect is unavailable", () =>
    Effect.gen(function* () {
      const publication = yield* inspectRelaySftpPublicationEffect(
        2022,
        "relay-container",
        () => Effect.fail(new Error("Docker socket unavailable"))
      )

      assert.deepEqual(publication, { port: 2022, status: "unknown" })
    })
  )

  it.effect("decodes a remapped port from Docker inspect", () =>
    Effect.gen(function* () {
      const publication = yield* inspectRelaySftpPublicationEffect(
        2022,
        "relay-container",
        () =>
          Effect.succeed({
            stderr: "",
            stdout: JSON.stringify({
              NetworkMode: "kiln",
              PortBindings: {
                "2022/tcp": [{ HostIp: "0.0.0.0", HostPort: "32022" }],
              },
            }),
          })
      )

      assert.deepEqual(publication, { port: 32_022, status: "published" })
    })
  )

  it("treats snapshots from older Relays as unknown", () => {
    const snapshot = relaySnapshotSchema.parse({
      instances: [],
      node: testNode,
      relay: {
        id: "r".repeat(43),
        name: "Test Relay",
        sftp: {
          developmentAuthentication: false,
          host: "relay.example.com",
          hostKeyFingerprint: "SHA256:relay-fingerprint",
          port: 2022,
        },
        tls: null,
      },
    })

    assert.strictEqual(snapshot.relay?.sftp.publication, "unknown")
  })
})

const testNode = {
  arch: "arm64",
  capabilities: [],
  canProvisionInstances: true,
  connectedAt: "2026-08-08T12:00:00.000Z",
  cpu: { cores: 8, loadPercent: 10 },
  docker: { available: true, version: "28.0.0" },
  id: "relay-test",
  memory: { totalBytes: 16_000, usedBytes: 8_000 },
  name: "Test Relay",
  platform: "linux",
  startedAt: "2026-08-08T11:00:00.000Z",
  storage: { totalBytes: 100_000, usedBytes: 50_000 },
  uptimeSeconds: 3_600,
  version: "0.1.0",
}
