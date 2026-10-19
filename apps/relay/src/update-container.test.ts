import { it as effectIt } from "@effect/vitest"
import { Effect, Fiber } from "effect"
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
    current.networks.set("kiln", {
      aliases: ["hearth", current.id],
      ipAddress: "",
    })
    current.networks.set("edge", {
      aliases: ["hearth-edge", "b".repeat(64)],
      ipAddress: "",
    })
    fakeDocker.images.set(targetDigest, targetLabels)
    fakeDocker.imageConfigs.set(targetDigest, {
      Healthcheck: {
        Interval: 5_000_000_000,
        Test: ["CMD", "new-healthcheck"],
      },
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
          "io.kiln.update-operation": expect.any(String),
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

  effectIt.effect(
    "labels a container from before installation IDs with this installation",
    () =>
      Effect.gen(function* () {
        const { docker } = yield* runningHearth()

        yield* replaceContainerEffect(
          { ...replacement, installationId: "kiln-installation" },
          docker,
          ignorePhase
        )

        expect(hearth()?.labels["io.kiln.installation"]).toBe(
          "kiln-installation"
        )
      })
  )

  effectIt.effect("keeps the installation a container is labeled with", () =>
    Effect.gen(function* () {
      const { current, docker } = yield* runningHearth()
      current.labels["io.kiln.installation"] = "kiln-original"

      yield* replaceContainerEffect(
        { ...replacement, installationId: "kiln-installation" },
        docker,
        ignorePhase
      )

      expect(hearth()?.labels["io.kiln.installation"]).toBe("kiln-original")
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
    "restarts the old container when renaming it aside fails",
    () =>
      Effect.gen(function* () {
        const { current, docker, oldImage } = yield* runningHearth()
        // A backup left behind by an earlier update holds the name.
        const leftover = fakeDocker.addContainer({ name: "hearth-backup" })

        const failure = yield* replaceContainerEffect(
          replacement,
          docker,
          ignorePhase
        ).pipe(Effect.flip)

        expect(failure.reason).toContain("is already in use")
        expect(failure.rollbackFailures).toEqual([])
        expect(hearth()?.id).toBe(current.id)
        expect(hearth()?.state.running).toBe(true)
        expect(fakeDocker.container("hearth-backup")?.id).toBe(leftover.id)
        expect(channelTarget()).toBe(oldImage)
      })
  )

  effectIt.effect(
    "puts back the old container's name when a rename Docker applied reports a failure",
    () =>
      Effect.gen(function* () {
        const { current, docker, oldImage } = yield* runningHearth()
        fakeDocker.failAfterNext(
          { command: "rename", target: "hearth" },
          "context deadline exceeded"
        )

        const failure = yield* replaceContainerEffect(
          replacement,
          docker,
          ignorePhase
        ).pipe(Effect.flip)

        expect(failure.rollbackFailures).toEqual([])
        expect(hearth()?.id).toBe(current.id)
        expect(hearth()?.state.running).toBe(true)
        expect(fakeDocker.container("hearth-backup")).toBeUndefined()
        expect(channelTarget()).toBe(oldImage)
      })
  )

  effectIt.effect(
    "restarts the old container when a stop that stopped it reports a failure",
    () =>
      Effect.gen(function* () {
        const { current, docker } = yield* runningHearth()
        fakeDocker.failAfterNext(
          { command: "stop", target: "hearth" },
          "context deadline exceeded"
        )

        yield* replaceContainerEffect(replacement, docker, ignorePhase).pipe(
          Effect.flip
        )

        expect(hearth()?.id).toBe(current.id)
        expect(hearth()?.state.running).toBe(true)
      })
  )

  effectIt.effect(
    "removes a replacement Docker created when the answer to its create was lost",
    () =>
      Effect.gen(function* () {
        const { current, docker, oldImage } = yield* runningHearth()
        fakeDocker.failAfterNext(
          { command: "create", target: "hearth" },
          "context deadline exceeded"
        )

        const failure = yield* replaceContainerEffect(
          replacement,
          docker,
          ignorePhase
        ).pipe(Effect.flip)

        expect(failure.rollbackFailures).toEqual([])
        expect(hearth()?.id).toBe(current.id)
        expect(hearth()?.state.running).toBe(true)
        expect([...fakeDocker.containers.values()]).toHaveLength(1)
        expect(channelTarget()).toBe(oldImage)
      })
  )

  effectIt.effect(
    "leaves a container it didn't create that took the name, and reports it",
    () =>
      Effect.gen(function* () {
        const { current, docker } = yield* runningHearth()
        // Something unrelated takes the name while the replacement is being
        // created, so the create fails.
        const create = fakeDocker.hold({ command: "create", target: "hearth" })
        const replacing = Effect.runFork(
          replaceContainerEffect(replacement, docker, ignorePhase).pipe(
            Effect.flip
          )
        )
        yield* Effect.promise(() => create.reached)
        const stranger = fakeDocker.addContainer({
          name: "hearth",
          running: true,
        })
        create.fail('Conflict. The container name "/hearth" is already in use')
        const failure = yield* Fiber.join(replacing)

        expect(fakeDocker.container(stranger.id)).toMatchObject({
          name: "hearth",
          state: { running: true },
        })
        expect(fakeDocker.container(current.id)?.name).toBe("hearth-backup")
        expect(failure.rollbackFailures.join(" ")).toContain("didn't create")
      })
  )

  effectIt.effect(
    "keeps a healthy replacement when removing the old container fails after Docker removed it",
    () =>
      Effect.gen(function* () {
        const { current, docker } = yield* runningHearth()
        fakeDocker.failAfterNext({ command: "rm" }, "context deadline exceeded")

        yield* replaceContainerEffect(replacement, docker, ignorePhase)

        expect(hearth()?.id).not.toBe(current.id)
        expect(hearth()?.state.running).toBe(true)
        expect(fakeDocker.container(current.id)).toBeUndefined()
      })
  )

  effectIt.effect(
    "counts a failed replacement as removed when Docker removed it but the answer was lost",
    () =>
      Effect.gen(function* () {
        const { current, docker } = yield* runningHearth()
        fakeDocker.unhealthyImages.add(channelReference)
        fakeDocker.failAfterNext({ command: "rm" }, "context deadline exceeded")

        const failure = yield* replaceContainerEffect(
          replacement,
          docker,
          ignorePhase
        ).pipe(Effect.flip)

        expect(failure.rollbackFailures).toEqual([])
        expect(hearth()?.id).toBe(current.id)
        expect(hearth()?.state.running).toBe(true)
        expect([...fakeDocker.containers.values()]).toHaveLength(1)
      })
  )

  effectIt.effect(
    "restarts the old container when the rename back reports a failure Docker applied",
    () =>
      Effect.gen(function* () {
        const { current, docker, oldImage } = yield* runningHearth()
        fakeDocker.unhealthyImages.add(channelReference)
        fakeDocker.failAfterNext(
          { command: "rename", target: current.id },
          "context deadline exceeded"
        )

        const failure = yield* replaceContainerEffect(
          replacement,
          docker,
          ignorePhase
        ).pipe(Effect.flip)

        expect(failure.rollbackFailures).toEqual([])
        expect(hearth()?.id).toBe(current.id)
        expect(hearth()?.state.running).toBe(true)
        expect(channelTarget()).toBe(oldImage)
      })
  )

  effectIt.effect(
    "attempts every rollback step and reports rollback failures",
    () =>
      Effect.gen(function* () {
        const { current, docker, oldImage } = yield* runningHearth()
        fakeDocker.unhealthyImages.add(channelReference)
        fakeDocker.failNext({ command: "rm" }, "removal failed")

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
