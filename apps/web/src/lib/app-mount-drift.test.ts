import { appMountFileName } from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import { mountAwaitsDeploy, mountsLeftBehind } from "@/lib/app-mount-drift"

const named = {
  destination: "/data",
  readOnly: false,
  source: "kiln-uploads",
  type: "volume",
}
const uploads = {
  readOnly: false,
  service: null,
  source: "kiln-uploads",
  target: "/data",
}

describe("mountAwaitsDeploy", () => {
  it("clears once the container mounts it as saved", () => {
    expect(
      mountAwaitsDeploy([{ mounts: [named], service: "app" }], uploads)
    ).toBe(false)
  })

  it.each([
    ["isn't mounted", []],
    ["is read-only but saved read-write", [{ ...named, readOnly: true }]],
    ["mounts another volume there", [{ ...named, source: "kiln-other" }]],
  ])("waits when the container %s", (_, mounts) => {
    expect(mountAwaitsDeploy([{ mounts, service: "app" }], uploads)).toBe(true)
  })

  it("has nothing to wait for until something runs", () => {
    expect(mountAwaitsDeploy([], uploads)).toBe(false)
  })

  it("looks only at the service it's for, and its newest container", () => {
    const containers = [
      { mounts: [named], service: "web" },
      { mounts: [], service: "web" },
      { mounts: [], service: "worker" },
    ]
    expect(mountAwaitsDeploy(containers, { ...uploads, service: "web" })).toBe(
      false
    )
    expect(mountAwaitsDeploy(containers, uploads)).toBe(true)
  })

  it("compares only what a container shows, and not Compose variables", () => {
    const containers = [
      {
        mounts: [{ ...named, source: "/kiln/mounts/abc", type: "bind" }],
        service: "app",
      },
    ]
    expect(
      mountAwaitsDeploy(containers, {
        ...uploads,
        readOnly: null,
        source: null,
      })
    ).toBe(false)
    expect(
      mountAwaitsDeploy(containers, { ...uploads, target: "${DATA}/x" })
    ).toBe(false)
  })
})

describe("mountAwaitsDeploy for a file's contents", () => {
  const deployed = appMountFileName("abcd1234", "first")
  const containers = [
    {
      mounts: [
        {
          destination: "/app/config",
          readOnly: true,
          source: `/kiln/app-mounts/app/deployment/${deployed}`,
          type: "bind",
        },
      ],
      service: "app",
    },
  ]
  const wanted = (content: string) => ({
    readOnly: true,
    service: null,
    source: null,
    sourceFile: appMountFileName("abcd1234", content),
    target: "/app/config",
  })

  it("waits for changed contents and clears on what's deployed", () => {
    expect(mountAwaitsDeploy(containers, wanted("first"))).toBe(false)
    expect(mountAwaitsDeploy(containers, wanted("second"))).toBe(true)
  })

  it("can't tell for a file deployed before names carried a version", () => {
    const older = [
      {
        mounts: [
          {
            destination: "/app/config",
            readOnly: true,
            source: "/kiln/app-mounts/app/deployment/abcd1234",
            type: "bind",
          },
        ],
        service: "app",
      },
    ]
    expect(mountAwaitsDeploy(older, wanted("second"))).toBe(false)
  })
})

describe("mountsLeftBehind", () => {
  const removed = [uploads]
  const running = (mount: typeof named) => [{ mounts: [mount], service: "app" }]

  it("notices a named volume no longer wanted", () => {
    expect(mountsLeftBehind(running(named), [], { compose: false })).toBe(true)
    expect(mountsLeftBehind(running(named), removed, { compose: false })).toBe(
      false
    )
  })

  it("never counts what nobody set, or it would never clear", () => {
    const anonymous = { ...named, source: "a".repeat(64) }
    const tmpfs = { ...named, source: "", type: "tmpfs" }
    expect(mountsLeftBehind(running(anonymous), [], { compose: false })).toBe(
      false
    )
    expect(mountsLeftBehind(running(tmpfs), [], { compose: false })).toBe(false)
  })

  it("leaves a Compose file's own binds alone", () => {
    const bind = { ...named, source: "/srv/secret", type: "bind" }
    expect(mountsLeftBehind(running(bind), [], { compose: true })).toBe(false)
    expect(mountsLeftBehind(running(bind), [], { compose: false })).toBe(true)
  })

  it("says nothing while a variable hides what's wanted", () => {
    expect(
      mountsLeftBehind(running(named), [{ ...uploads, target: "${DATA}" }], {
        compose: false,
      })
    ).toBe(false)
  })
})
