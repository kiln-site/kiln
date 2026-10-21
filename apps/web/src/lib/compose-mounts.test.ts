import { describe, expect, it } from "vite-plus/test"

import {
  changeComposeMount,
  composeMountProblem,
  composeMounts,
} from "./compose-mounts"

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

  it("keeps a volume declared through an alias when a mount changes", () => {
    const aliased = `x-volumes: &volumes
  data:
    name: production-data
services:
  app:
    image: app
    volumes:
      - data:/data
volumes: *volumes
`
    const [mount] = composeMounts(aliased, project)!
    const changed = changeComposeMount(aliased, mount!.key, {
      readOnly: true,
      source: "data",
      target: "/data",
    })
    expect(changed).toBe(aliased.replace("data:/data", "data:/data:ro"))
    expect(composeMounts(changed, project)![0]!.dockerName).toBe(
      "production-data"
    )
  })

  it("keeps a long mount's type through a change", () => {
    const long = `services:
  app:
    image: app
    volumes:
      - type: bind
        source: state
        target: /state
      - type: volume
        source: \${VOLUME:-data}
        target: /data
volumes:
  data: {}
`
    let changed = long
    for (const mount of composeMounts(long, project)!) {
      changed = changeComposeMount(changed, mount.key, {
        readOnly: true,
        source: mount.source,
        target: mount.target,
      })
    }
    expect(
      composeMounts(changed, project)!.map((mount) => [
        mount.kind,
        mount.readOnly,
      ])
    ).toEqual([
      ["bind", true],
      ["volume", true],
    ])
  })

  it("leaves alone what an anchor shares with another service", () => {
    const anchored = `services:
  web:
    image: web
    volumes:
      - &shared data:/data
  worker:
    image: worker
    volumes:
      - *shared
volumes:
  data: {}
`
    const found = composeMounts(anchored, project)!
    expect(found.map((mount) => [mount.service, mount.editable])).toEqual([
      ["web", false],
      ["worker", false],
    ])
    for (const mount of found) {
      expect(
        changeComposeMount(anchored, mount.key, {
          readOnly: false,
          source: "other",
          target: "/data",
        })
      ).toBe(anchored)
      expect(changeComposeMount(anchored, mount.key, null)).toBe(anchored)
    }
  })

  it("makes an anonymous volume read-only", () => {
    const changed = changeComposeMount(file, keyOf("/scratch"), {
      readOnly: true,
      source: "",
      target: "/scratch",
    })
    expect(
      composeMounts(changed, project)!.find(
        (mount) => mount.target === "/scratch"
      )
    ).toEqual(
      expect.objectContaining({ kind: "volume", readOnly: true, source: "" })
    )
  })

  it("leaves alone a mount that shares or inherits any part of itself", () => {
    const shared = `x-mount: &mount
  type: volume
  source: data
  target: /data
  read_only: true
x-base: &base
  image: base
  volumes:
    - data:/data
services:
  web:
    image: web
    volumes:
      - type: volume
        source: &source data
        target: /data
  api:
    image: api
    volumes:
      - type: volume
        source: *source
        target: /data
  worker:
    image: worker
    volumes:
      - <<: *mount
  job:
    <<: *base
    volumes:
      - cache:/cache
volumes:
  data: {}
  cache: {}
`
    const found = composeMounts(shared, project)!
    expect(found.map((mount) => [mount.service, mount.editable])).toEqual([
      ["web", false],
      ["api", false],
      ["worker", false],
      ["job", false],
    ])
    for (const mount of found) {
      expect(
        changeComposeMount(shared, mount.key, {
          readOnly: false,
          source: "other",
          target: "/other",
        })
      ).toBe(shared)
      expect(changeComposeMount(shared, mount.key, null)).toBe(shared)
    }
  })

  it("won't name a volume it can't declare without changing shared declarations", () => {
    for (const declarations of [
      "x-volumes: &volumes\n  data: {}\nvolumes: *volumes\n",
      "x-volumes: &volumes\n  data: {}\nvolumes:\n  <<: *volumes\n",
      "x-root: &root\n  volumes:\n    data: {}\n<<: *root\n",
    ]) {
      const text = `services:
  app:
    image: app
    volumes:
      - data:/data
${declarations}`
      const [mount] = composeMounts(text, project)!
      expect(() =>
        changeComposeMount(text, mount!.key, {
          readOnly: false,
          source: "new-data",
          target: "/data",
        })
      ).toThrow("Declare the volume new-data")
    }
  })

  it("leaves alone a mount whose settings a variable decides", () => {
    const text = `services:
  app:
    image: app
    volumes:
      - type: bind
        source: ./state
        target: /state
        read_only: \${READ_ONLY:-true}
      - data:/data:\${MODE:-ro}
volumes:
  data: {}
`
    const found = composeMounts(text, project)!
    expect(found.map((mount) => mount.editable)).toEqual([false, false])
    for (const mount of found) {
      expect(
        changeComposeMount(text, mount.key, {
          readOnly: false,
          source: mount.source,
          target: "/elsewhere",
        })
      ).toBe(text)
    }
  })

  it("refuses a path with a colon, which the short syntax reads as its mode", () => {
    const [mount] = mounts()
    expect(
      composeMountProblem(mount!, {
        readOnly: false,
        source: mount!.source,
        target: "/data:ro",
      })
    ).not.toBeNull()
  })

  it("reads no mounts, rather than failing, from a file of too many aliases", () => {
    const services = Array.from(
      { length: 101 },
      (_, at) => `  app${at}: *base`
    ).join("\n")
    const text = `x-base: &base
  image: app
  volumes:
    - data:/data
services:
${services}
volumes:
  data: {}
`
    expect(composeMounts(text, project)).toBeNull()
  })

  it("declares a volume named like an object's own property", () => {
    const changed = changeComposeMount(file, keyOf("/cache"), {
      readOnly: false,
      source: "constructor",
      target: "/cache",
    })
    expect(changed).toMatch(/^ {2}constructor: \{\}$/mu)
  })

  it("writes only what changes, leaving every other byte as it was", () => {
    const text = `services:
  bot:
    image: bot
    entrypoint: ["/bin/sh", "-ec"]
    environment:
      DISCORD_GUILD_ID: 1234567890123456789
    volumes:
      - data:/data   # kept
      - type: volume
        source: logs
        target: /logs
        read_only: true
      - /scratch
    secrets:
      - source: token
        mode: 0440
volumes:
  data: {}
  logs: {}
secrets:
  token:
    file: ./token
`
    const keyAt = (target: string) =>
      composeMounts(text, project)!.find((mount) => mount.target === target)!
        .key
    expect(
      changeComposeMount(text, keyAt("/data"), {
        readOnly: true,
        source: "cache",
        target: "/data",
      })
    ).toBe(
      text
        .replace("data:/data   # kept", "cache:/data:ro   # kept")
        .replace("  logs: {}\n", "  logs: {}\n  cache: {}\n")
    )
    expect(
      changeComposeMount(text, keyAt("/logs"), {
        readOnly: false,
        source: "logs",
        target: "/var/log",
      })
    ).toBe(
      text
        .replace("target: /logs\n        read_only: true\n", "target: /var/log\n        read_only: false\n")
    )
    expect(
      changeComposeMount(text, keyAt("/scratch"), {
        readOnly: true,
        source: "",
        target: "/scratch",
      })
    ).toBe(
      text.replace(
        "- /scratch",
        "- { type: volume, target: /scratch, read_only: true }"
      )
    )
    expect(changeComposeMount(text, keyAt("/scratch"), null)).toBe(
      text.replace("      - /scratch\n", "")
    )
    expect(changeComposeMount(text, keyAt("/run/secrets/token"), null)).toBe(
      text.replace("    secrets:\n      - source: token\n        mode: 0440\n", "")
    )
  })

  it("declares a volume where the file has none declared yet", () => {
    for (const [declarations, expected] of [
      ["", "volumes:\n  data: {}\n"],
      ["volumes:\n", "volumes:\n  data: {}\n"],
    ] as const) {
      const text = `services:\n  app:\n    image: app\n    volumes:\n      - ./data:/data\n${declarations}`
      const [mount] = composeMounts(text, project)!
      expect(
        changeComposeMount(text, mount!.key, {
          readOnly: false,
          source: "data",
          target: "/data",
        })
      ).toBe(
        `services:\n  app:\n    image: app\n    volumes:\n      - data:/data\n${expected}`
      )
    }
  })

  it("leaves alone a mount written whole in a variable, or whose access isn't plainly true or false", () => {
    const text = `services:
  db:
    image: postgres
    volumes:
      - \${DB_MOUNT:-data:/var/lib/postgresql/data:ro}
      - type: volume
        source: data
        target: /data
        read_only: "true"
volumes:
  data: {}
`
    const found = composeMounts(text, project)!
    expect(found.map((mount) => mount.editable)).toEqual([false, false])
    expect(found[1]!.readOnly).toBe(true)
    for (const mount of found) {
      expect(
        changeComposeMount(text, mount.key, {
          readOnly: false,
          source: "data",
          target: "/elsewhere",
        })
      ).toBe(text)
    }
  })

  it("removes the last mount and nothing after it", () => {
    const text = `services:
  app:
    image: app
    volumes:
      - type: volume
        target: /data
        # end of mounts
    restart: always
`
    const [mount] = composeMounts(text, project)!
    const changed = changeComposeMount(text, mount!.key, null)
    expect(changed).toContain("    restart: always\n")
    expect(changed).not.toContain("volumes:")
  })

  it("leaves alone a long mount with a block scalar in it", () => {
    const text = `services:
  app:
    image: app
    volumes:
      - type: bind
        source: >-
          ./state
        target: /data
`
    expect(composeMounts(text, project)![0]!.editable).toBe(false)
  })

  it("writes paths and names YAML would read as something else so they read back as written", () => {
    const text = `services:
  app:
    image: app
    volumes:
      - /scratch
      - ./data:/data
    configs:
      - init
configs:
  init:
    file: ./init.sql
`
    const keyAt = (target: string) =>
      composeMounts(text, project)!.find((mount) => mount.target === target)!
        .key
    for (const [target, change] of [
      ["/scratch", { readOnly: true, source: "", target: "/path,other[1]" }],
      [
        "/data",
        {
          readOnly: false,
          source: "./data",
          target: `/${"a very long path with spaces ".repeat(6)}end`,
        },
      ],
      ["/init", { readOnly: true, source: "init", target: "/etc/a, b" }],
      ["/data", { readOnly: false, source: "001", target: "/data" }],
      ["/data", { readOnly: false, source: "null", target: "/data" }],
    ] as const) {
      const changed = changeComposeMount(text, keyAt(target), change)
      const after = composeMounts(changed, project)!.find(
        (mount) => mount.target === change.target
      )
      expect(after).toEqual(
        expect.objectContaining({
          readOnly: change.readOnly,
          source: change.source,
        })
      )
    }
  })

  it("refuses to declare a volume where appending one would break the file", () => {
    for (const text of [
      "services:\n  app:\n    image: app\n    volumes:\n      - ./data:/data\n...\n",
      "  services:\n    app:\n      image: app\n      volumes:\n        - ./data:/data\n",
    ]) {
      const [mount] = composeMounts(text, project)!
      expect(() =>
        changeComposeMount(text, mount!.key, {
          readOnly: false,
          source: "data",
          target: "/data",
        })
      ).toThrow()
    }
  })

  it("reads ro and rw as Compose does, and leaves a mode with both alone", () => {
    const text = `services:
  app:
    image: app
    volumes:
      - data:/data:ro,rw
      - logs:/logs:rw,ro
      - type: volume
        read_only: false
        source: cache
        target: /cache
      - !reset /scratch
volumes:
  data: {}
  logs: {}
  cache: {}
`
    const found = composeMounts(text, project)!
    expect(
      found.map((mount) => [mount.target, mount.readOnly, mount.editable])
    ).toEqual([
      ["/data", false, false],
      ["/logs", true, false],
      ["/cache", false, true],
      ["/scratch", false, false],
    ])
    // An explicit false that comes first stays put through a change.
    const changed = changeComposeMount(text, found[2]!.key, {
      readOnly: false,
      source: "cache",
      target: "/var/cache",
    })
    expect(changed).toBe(text.replace("target: /cache", "target: /var/cache"))
  })

  it("won't drop a volume's options by making it anonymous", () => {
    const text = `services:
  app:
    image: app
    volumes:
      - data:/data:nocopy
volumes:
  data: {}
`
    const [mount] = composeMounts(text, project)!
    for (const readOnly of [false, true]) {
      expect(() =>
        changeComposeMount(text, mount!.key, {
          readOnly,
          source: "",
          target: "/data",
        })
      ).toThrow("nocopy")
    }
  })

  it("keeps a path's spaces through a change", () => {
    const text = `services:
  app:
    image: app
    volumes:
      - "./state :/state"
      - type: bind
        source: "./logs "
        target: /logs
`
    let changed = text
    for (const mount of composeMounts(text, project)!) {
      changed = changeComposeMount(changed, mount.key, {
        readOnly: true,
        source: mount.source,
        target: mount.target,
      })
    }
    expect(
      composeMounts(changed, project)!.map((mount) => [
        mount.source,
        mount.readOnly,
      ])
    ).toEqual([
      ["./state ", true],
      ["./logs ", true],
    ])
  })
})
