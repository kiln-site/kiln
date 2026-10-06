import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

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
})
