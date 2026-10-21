import { describe, expect, it } from "vite-plus/test"

import { changeComposeMount, composeMounts } from "./compose-mounts"

const project = "kiln-app-abc"

const file = `# Observability
services:
  grafana:
    image: grafana/grafana
    volumes:
      # Its dashboards and users.
      - ./state/grafana:/var/lib/grafana
      - \${CONFIG:-./config}:/etc/grafana:ro,z
      - cache:/cache
      - /scratch
  db:
    image: postgres
    volumes:
      - type: volume
        source: data
        target: /var/lib/postgresql/data
        read_only: true
    configs:
      - init
    secrets:
      - source: password
        target: /run/password
volumes:
  data:
    name: shared-data
  cache: {}
configs:
  init:
    file: ./init.sql
secrets:
  password:
    environment: DB_PASSWORD
`

const mounts = () => composeMounts(file, project) ?? []
const keyOf = (target: string) =>
  mounts().find((mount) => mount.target === target)!.key

describe("compose mounts", () => {
  it("reads what each service mounts, and what Docker names its volumes", () => {
    expect(
      mounts().map(({ dockerName, kind, readOnly, service, source, target }) => [
        service,
        kind,
        source,
        target,
        readOnly,
        dockerName,
      ])
    ).toEqual([
      ["grafana", "bind", "./state/grafana", "/var/lib/grafana", false, null],
      ["grafana", "bind", "${CONFIG:-./config}", "/etc/grafana", true, null],
      ["grafana", "volume", "cache", "/cache", false, `${project}_cache`],
      ["grafana", "volume", "", "/scratch", false, null],
      ["db", "volume", "data", "/var/lib/postgresql/data", true, "shared-data"],
      ["db", "config", "init", "/init", true, null],
      ["db", "secret", "password", "/run/password", true, null],
    ])
    expect(composeMounts("services: [", project)).toBeNull()
  })

  it("changes one mount and leaves the rest of the file as it was", () => {
    const changed = changeComposeMount(file, keyOf("/etc/grafana"), {
      readOnly: false,
      source: "${CONFIG:-./config}",
      target: "/etc/grafana",
    })
    expect(changed).toBe(
      file.replace(
        "${CONFIG:-./config}:/etc/grafana:ro,z",
        "${CONFIG:-./config}:/etc/grafana:z"
      )
    )

    const long = changeComposeMount(file, keyOf("/var/lib/postgresql/data"), {
      readOnly: false,
      source: "data",
      target: "/data",
    })
    expect(long).toContain(
      "      - type: volume\n        source: data\n        target: /data\n"
    )
    expect(long).toContain("# Its dashboards and users.")
  })

  it("declares a volume a mount newly names, so the file still deploys", () => {
    const changed = changeComposeMount(file, keyOf("/var/lib/grafana"), {
      readOnly: false,
      source: "grafana",
      target: "/var/lib/grafana",
    })
    const after = composeMounts(changed, project)!
    expect(after.find((mount) => mount.target === "/var/lib/grafana")).toEqual(
      expect.objectContaining({
        dockerName: `${project}_grafana`,
        kind: "volume",
      })
    )
    expect(changed).toMatch(/^volumes:\n(.*\n)*  grafana: \{\}/mu)
  })

  it("removes a mount, and the list it leaves empty", () => {
    let changed = changeComposeMount(file, keyOf("/run/password"), null)
    expect(changed).not.toContain("/run/password")
    expect(changed).not.toMatch(/^ {4}secrets:/mu)
    // The top-level secret stays; only the mount went.
    expect(changed).toContain("environment: DB_PASSWORD")

    changed = changeComposeMount(file, keyOf("/var/lib/grafana"), null)
    expect(
      composeMounts(changed, project)!.map((mount) => mount.target)
    ).toEqual([
      "/etc/grafana",
      "/cache",
      "/scratch",
      "/var/lib/postgresql/data",
      "/init",
      "/run/password",
    ])
  })
})
