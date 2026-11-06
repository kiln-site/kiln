import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vite-plus/test"

import {
  cacheNamespace,
  grantPattern,
  isReservedProject,
  sqlIdentifier,
  sqlString,
  stackResources,
  withBoxLock,
  withStackLock,
} from "./dev-shared.mjs"

const module = fileURLToPath(new URL("dev-shared.mjs", import.meta.url))

describe("stack resources", () => {
  it("can't collide between a stack and another's test databases", () => {
    const stack = stackResources("kiln-a")
    const namedLikeItsTests = stackResources("kiln-a-test-1")

    expect(stack.database).toMatch(/^s_[a-f0-9]{12}$/u)
    expect(stack.user).toMatch(/^u_[a-f0-9]{12}$/u)
    expect(stack.testDatabase).toMatch(/^t_[a-f0-9]{12}_test$/u)
    expect(namedLikeItsTests.database.startsWith(stack.testDatabase)).toBe(
      false
    )
    expect(namedLikeItsTests.testDatabase).not.toBe(stack.testDatabase)
  })

  it("keeps stacks off the box's own Compose projects", () => {
    expect(isReservedProject("kiln-dev-shared")).toBe(true)
    expect(isReservedProject("kiln-dev-s3")).toBe(true)
    expect(isReservedProject("kiln-shared-a")).toBe(false)
  })

  it("leaves room for the longest test database name", () => {
    const { testDatabase } = stackResources("a".repeat(63))

    expect(`${testDatabase}_128_auth_startup`.length).toBeLessThanOrEqual(64)
  })
})

describe("sql text", () => {
  it("escapes grant wildcards", () => {
    expect(grantPattern("s_ab%c")).toBe("s\\_ab\\%c")
    expect(grantPattern("t_abc_test") + "%").toBe("t\\_abc\\_test%")
  })

  it("keeps a hostile database name inside its identifier", () => {
    expect(sqlIdentifier("t_a_test_x`;DROP DATABASE s_b;#")).toBe(
      "`t_a_test_x``;DROP DATABASE s_b;#`"
    )
  })

  it("quotes strings", () => {
    expect(sqlString("it's\\here")).toBe("'it''s\\\\here'")
  })
})

describe("cache namespace", () => {
  it("matches Hearth's", () => {
    expect(
      cacheNamespace({
        database: "s_aaaaaaaaaaaa",
        host: "kiln-dev-mysql",
        port: 3306,
        tablePrefix: "kiln_",
      })
    ).toBe("kiln:hearth:v1:ab932f5f8e5c2cfa")
  })
})

describe("stack lock", () => {
  it("runs one command at a time on a stack", async () => {
    const order = []
    const hold = (name, milliseconds) =>
      withStackLock("kiln-lock-test", async () => {
        order.push(`${name} in`)
        await new Promise((settle) => setTimeout(settle, milliseconds))
        order.push(`${name} out`)
      })

    await Promise.all([hold("a", 80), hold("b", 1)])

    expect(order).toEqual(["a in", "a out", "b in", "b out"])
  })
})

describe("box lock", () => {
  const port = 29_901

  it("runs one holder at a time", async () => {
    const order = []
    const hold = (name, milliseconds) =>
      withBoxLock(
        async () => {
          order.push(`${name} in`)
          await new Promise((settle) => setTimeout(settle, milliseconds))
          order.push(`${name} out`)
        },
        { port }
      )

    await Promise.all([hold("a", 80), hold("b", 1)])

    expect(order).toEqual(["a in", "a out", "b in", "b out"])
  })

  it("gives up when a holder keeps it", async () => {
    await withBoxLock(
      () =>
        expect(
          withBoxLock(() => undefined, { port, timeoutMs: 50 })
        ).rejects.toThrow("Timed out"),
      { port }
    )
  })

  it("is released when its holder is killed", async () => {
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { withBoxLock } from ${JSON.stringify(module)}
         await withBoxLock(() => {
           console.log("held")
           return new Promise((settle) => setTimeout(settle, 60000))
         }, { port: ${port} })`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    )
    await new Promise((settle) => holder.stdout.once("data", settle))
    holder.kill("SIGKILL")

    await expect(
      withBoxLock(() => "acquired", { port, timeoutMs: 5_000 })
    ).resolves.toBe("acquired")
  })
})
