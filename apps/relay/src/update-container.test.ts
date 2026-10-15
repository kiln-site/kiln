import { it as effectIt } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vite-plus/test"

import { DockerEngine } from "./docker-engine.js"
import { fakeDocker } from "./test/docker.js"
import {
  KILN_IMAGE_SOURCE,
  managedImageChannel,
  replaceContainerEffect,
} from "./update-container.js"

const channelReference = "ghcr.io/kiln-site/hearth:latest-nightly"
const targetDigest = `ghcr.io/kiln-site/hearth@sha256:${"c".repeat(64)}`
const replacement = {
  backupName: "hearth-backup",
  targetContainer: "hearth",
  targetImage: targetDigest,
  targetReference: channelReference,
  targetVersion: "0.1.0-nightly.2",
}
const targetLabels = {
  "io.kiln.component": "hearth",
  "org.opencontainers.image.revision": "new-commit",
  "org.opencontainers.image.source": KILN_IMAGE_SOURCE,
  "org.opencontainers.image.version": "0.1.0-nightly.2",
}
const ignorePhase = () => Effect.void

afterEach(() => {
  fakeDocker.reset()
})

/**
 * Hearth running from the nightly channel tag on two networks, and the
 * pulled target image, which declares a health check.
 */
function runningHearth(options: { hostname?: string } = {}) {
  return Effect.promise(async () => {
    fakeDocker.addNetwork({ name: "kiln" })
    fakeDocker.addNetwork({ name: "edge" })
    const current = fakeDocker.addContainer({
      cmd: ["old-command"],
      env: { EXAMPLE: "true" },
      image: channelReference,
      labels: {
        "coolify.managed": "true",
        "io.kiln.component": "hearth",
        "org.opencontainers.image.revision": "old-commit",
        "org.opencontainers.image.source": KILN_IMAGE_SOURCE,
        "org.opencontainers.image.version": "0.1.0-nightly.1",
      },
      name: "hearth",
      networks: ["kiln", "edge"],
      restartPolicy: "unless-stopped",
      running: true,
    })
    // Docker named the host after the container, unless it was given one.
    current.hostname = options.hostname ?? current.id.slice(0, 12)
    current.networks.set("kiln", { aliases: ["hearth", current.id], ipAddress: "" })
    current.networks.set("edge", {
      aliases: ["hearth-edge", "b".repeat(64)],
      ipAddress: "",
    })
    fakeDocker.images.set(targetDigest, targetLabels)
    fakeDocker.imageConfigs.set(targetDigest, {
      Healthcheck: { Interval: 5_000_000_000, Test: ["CMD", "new-healthcheck"] },
    })
    const docker = new DockerEngine(await fakeDocker.listen())
    return { current, docker, oldImage: `sha256:${channelReference}` }
  })
}

const hearth = () => fakeDocker.container("hearth")
const channelTarget = () =>
  fakeDocker.imageTags.get("ghcr.io/kiln-site/hearth:latest-nightly")

describe("managed update channels", () => {
  it("accepts only the matching floating channel tags", () => {
    expect(
      managedImageChannel("ghcr.io/kiln-site/hearth:latest", "hearth")
    ).toBe("ghcr.io/kiln-site/hearth:latest")
    expect(
      managedImageChannel("ghcr.io/kiln-site/hearth:latest-nightly", "hearth")
    ).toBe("ghcr.io/kiln-site/hearth:latest-nightly")
    expect(
      managedImageChannel("ghcr.io/kiln-site/hearth:0.1.0", "hearth")
    ).toBeNull()
    expect(
      managedImageChannel(
        `ghcr.io/kiln-site/hearth@sha256:${"a".repeat(64)}`,
        "hearth"
      )
    ).toBeNull()
    expect(
      managedImageChannel("ghcr.io/kiln-site/relay:latest", "hearth")
    ).toBeNull()
  })
})

describe("container replacement", () => {
  effectIt.effect(
    "refreshes image metadata and Docker's generated hostname",
    () =>
      Effect.gen(function* () {
        const { current, docker } = yield* runningHearth()

        yield* replaceContainerEffect(replacement, docker, ignorePhase)

        const replaced = hearth()
        expect(replaced?.id).not.toBe(current.id)
        expect(replaced?.state).toMatchObject({
          health: "healthy",
          running: true,
        })
        expect(replaced?.image).toBe(channelReference)
        expect(replaced?.labels).toEqual({
          "coolify.managed": "true",
          ...targetLabels,
        })
        expect(replaced?.env).toEqual({ EXAMPLE: "true" })
        expect(replaced?.restartPolicy).toBe("unless-stopped")
        // The image's command and a fresh hostname, not the old container's.
        expect(replaced?.cmd).toEqual([])
        expect(replaced?.hostname).toBe(replaced?.id.slice(0, 12))
        expect(replaced?.networks.get("kiln")?.aliases).toContain("hearth")
        expect(replaced?.networks.get("edge")?.aliases).toEqual(
          expect.arrayContaining(["hearth-edge", "hearth"])
        )
        expect(fakeDocker.container("hearth-backup")).toBeUndefined()
        expect(fakeDocker.container(current.id)).toBeUndefined()
        expect(channelTarget()).toBe(`sha256:${targetDigest}`)
      })
  )

  effectIt.effect("reports replacement phases in execution order", () =>
    Effect.gen(function* () {
      const { docker } = yield* runningHearth()
      const phases: Array<string> = []

      yield* replaceContainerEffect(replacement, docker, (phase) =>
        Effect.sync(() => {
          phases.push(phase)
        })
      )

      expect(phases).toEqual([
        "replace.inspectContainer",
        "replace.tagTarget",
        "replace.stopCurrent",
        "replace.renameCurrent",
        "replace.createTarget",
        "replace.connectNetwork",
        "replace.startTarget",
        "replace.waitUntilHealthy",
        "replace.removeBackup",
      ])
    })
  )

  effectIt.effect("preserves an explicitly configured hostname", () =>
    Effect.gen(function* () {
      const { docker } = yield* runningHearth({ hostname: "hearth.internal" })

      yield* replaceContainerEffect(replacement, docker, ignorePhase)

      expect(hearth()?.hostname).toBe("hearth.internal")
    })
  )

  effectIt.effect(
    "records the stable release version for a promoted nightly image",
    () =>
      Effect.gen(function* () {
        const { docker } = yield* runningHearth()

        yield* replaceContainerEffect(
          {
            ...replacement,
            targetReference: "ghcr.io/kiln-site/hearth:latest",
            targetVersion: "0.1.0",
          },
          docker,
          ignorePhase
        )

        expect(hearth()?.labels["org.opencontainers.image.version"]).toBe(
          "0.1.0"
        )
      })
  )

  effectIt.effect(
    "restores the old container and channel image after a failed health check",
    () =>
      Effect.gen(function* () {
        const { current, docker, oldImage } = yield* runningHearth()
        fakeDocker.unhealthyImages.add(channelReference)

        const failure = yield* replaceContainerEffect(
          replacement,
          docker,
          ignorePhase
        ).pipe(Effect.flip)

        expect(failure.phase).toBe("replace")
        expect(failure.rollbackFailures).toEqual([])
        expect(hearth()?.id).toBe(current.id)
        expect(hearth()?.state.running).toBe(true)
        expect(fakeDocker.container("hearth-backup")).toBeUndefined()
        expect(channelTarget()).toBe(oldImage)
      })
  )

  effectIt.effect(
    "attempts every rollback step and reports rollback failures",
    () =>
      Effect.gen(function* () {
        const { current, docker, oldImage } = yield* runningHearth()
        fakeDocker.unhealthyImages.add(channelReference)
        fakeDocker.failNext({ command: "rm", target: "hearth" }, "removal failed")

        const failure = yield* replaceContainerEffect(
          replacement,
          docker,
          ignorePhase
        ).pipe(Effect.flip)

        expect(failure.rollbackFailures.length).toBeGreaterThan(0)
        // The old container is kept for manual recovery and the channel tag
        // is still restored after the earlier rollback step failed.
        expect(fakeDocker.container("hearth-backup")?.id).toBe(current.id)
        expect(channelTarget()).toBe(oldImage)
      })
  )
})
