import { beforeEach, describe, expect, it, vi } from "vite-plus/test"

import {
  databaseEngineSupportsLogicalBackups,
  type RelayManagedDatabase,
} from "@workspace/contracts"

import type { command as commandFunction } from "./command.js"

const commandMock = vi.hoisted(() => vi.fn<typeof commandFunction>())

vi.mock("./command.js", () => ({ command: commandMock }))

import {
  DatabaseDriver,
  databaseAclLoadArguments,
  databaseEngineSpec,
  databaseRecoveryLabels,
} from "./databases.js"
import { loadConfig } from "./config.js"
import type { DatabaseConnections } from "./database-connections.js"
import { DockerDriver } from "./docker.js"

beforeEach(() => {
  commandMock.mockReset()
})

describe("managed database recovery metadata", () => {
  it("only enables logical backups for SQL engines", () => {
    expect(databaseEngineSupportsLogicalBackups("mysql")).toBe(true)
    expect(databaseEngineSupportsLogicalBackups("mariadb")).toBe(true)
    expect(databaseEngineSupportsLogicalBackups("postgres")).toBe(true)
    expect(databaseEngineSupportsLogicalBackups("redis")).toBe(false)
    expect(databaseEngineSupportsLogicalBackups("valkey")).toBe(false)
  })

  it("uses supported official images and private internal ports", () => {
    expect(databaseEngineSpec("mysql")).toMatchObject({
      image: "mysql:8.4",
      internalPort: 3306,
      supportsImportExport: true,
    })
    expect(databaseEngineSpec("mariadb")).toMatchObject({
      image: "mariadb:11.8",
      internalPort: 3306,
      supportsImportExport: true,
    })
    expect(databaseEngineSpec("postgres")).toMatchObject({
      image: "postgres:17",
      internalPort: 5432,
      supportsImportExport: true,
    })
    expect(databaseEngineSpec("redis")).toMatchObject({
      image: "redis:8",
      internalPort: 6379,
      supportsImportExport: false,
    })
    expect(databaseEngineSpec("valkey")).toMatchObject({
      image: "valkey/valkey:8",
      internalPort: 6379,
      supportsImportExport: false,
    })
  })

  it("writes recoverable ownership labels without credentials", () => {
    const labels = databaseRecoveryLabels(
      { resourceNamespace: "kiln-test" },
      {
        databaseName: "kiln_app",
        engine: "postgres",
        id: "a".repeat(40),
        name: "Main database",
      },
      "2026-08-06T12:00:00.000Z"
    )

    expect(labels).toMatchObject({
      "kiln.database.database-name": "kiln_app",
      "kiln.database.engine": "postgres",
      "kiln.database.hostname": `database-${"a".repeat(40)}`,
      "kiln.database.id": "a".repeat(40),
      "kiln.database.image": "postgres:17",
      "kiln.database.name": "Main database",
      "kiln.relay.managed": "true",
      "kiln.relay.owner": "kiln-test",
      "kiln.relay.owned": "true",
      "kiln.resource.kind": "database",
    })
    expect(Object.keys(labels).join(" ")).not.toMatch(
      /password|username|secret/u
    )
  })

  it("does not collide resources when database ids share a short prefix", () => {
    const first = databaseRecoveryLabels(
      { resourceNamespace: "kiln-test" },
      {
        databaseName: "kiln_first",
        engine: "postgres",
        id: `${"a".repeat(8)}${"b".repeat(32)}`,
        name: "First database",
      },
      "2026-08-06T12:00:00.000Z"
    )
    const second = databaseRecoveryLabels(
      { resourceNamespace: "kiln-test" },
      {
        databaseName: "kiln_second",
        engine: "postgres",
        id: `${"a".repeat(8)}${"c".repeat(32)}`,
        name: "Second database",
      },
      "2026-08-06T12:00:00.000Z"
    )

    expect(first["kiln.database.hostname"]).not.toBe(
      second["kiln.database.hostname"]
    )
    expect(first["kiln.database.network"]).not.toBe(
      second["kiln.database.network"]
    )
    expect(first["kiln.database.volume"]).not.toBe(
      second["kiln.database.volume"]
    )
  })
})

describe("managed database credential rotation", () => {
  const credentialRotationCases: ReadonlyArray<
    readonly ["redis" | "valkey", string, string]
  > = [
    ["redis", "REDISCLI_AUTH", "redis-cli"],
    ["valkey", "VALKEYCLI_AUTH", "valkey-cli"],
  ]

  it.each(credentialRotationCases)(
    "passes %s authentication through the client environment",
    (engine, environmentName, client) => {
      const arguments_ = databaseAclLoadArguments(
        engine,
        "container-id",
        "kiln_user",
        "current-password"
      )

      expect(arguments_).toContain(`${environmentName}=current-password`)
      expect(arguments_).toContain(client)
      expect(arguments_).not.toContain("-a")
      expect(arguments_).not.toContain("current-password")
    }
  )
})

describe("managed database deletion", () => {
  it("removes owned network and volume resources without a container", async () => {
    const databaseId = "d".repeat(40)
    const config = loadConfig({
      KILN_RELAY_ALLOW_PROVISIONING: "true",
      KILN_RELAY_RESOURCE_NAMESPACE: "kiln-test",
      NODE_ENV: "test",
    })
    const network = `kiln-test-kiln-db-${databaseId}-network`
    const volume = `kiln-test-kiln-db-${databaseId}-data`
    commandMock.mockImplementation(async (_executable, arguments_) => {
      if (arguments_[0] === "container" && arguments_[1] === "ls") {
        return {
          stderr: "",
          stdout: arguments_.includes(`network=${network}`)
            ? "server-container\n"
            : "",
        }
      }
      if (arguments_[0] === "inspect" && arguments_[1] === "server-container") {
        return {
          stderr: "",
          stdout: JSON.stringify([
            {
              Config: { Labels: {} },
              Id: "server-container",
              Name: "/game-server",
            },
          ]),
        }
      }
      if (arguments_[0] === "network" && arguments_[1] === "inspect") {
        if (arguments_.at(-1) !== network) throw new Error("Network not found")
        return {
          stderr: "",
          stdout: JSON.stringify({
            "kiln.database.id": databaseId,
            "kiln.database.network": network,
            "kiln.relay.owner": "kiln-test",
            "kiln.resource.kind": "database",
          }),
        }
      }
      if (arguments_[0] === "volume" && arguments_[1] === "inspect") {
        if (arguments_.at(-1) !== volume) throw new Error("Volume not found")
        return {
          stderr: "",
          stdout: JSON.stringify({
            "kiln.database.id": databaseId,
            "kiln.database.volume": volume,
            "kiln.relay.owner": "kiln-test",
            "kiln.resource.kind": "database",
          }),
        }
      }
      if (
        (arguments_[0] === "network" && arguments_[1] === "rm") ||
        (arguments_[0] === "volume" && arguments_[1] === "rm")
      ) {
        return { stderr: "", stdout: "" }
      }
      throw new Error(`Unexpected Docker arguments: ${arguments_.join(" ")}`)
    })
    const driver = new DatabaseDriver(config, new DockerDriver(config))

    await expect(
      driver.delete({ databaseId, deleteData: true })
    ).resolves.toEqual({ databaseId, deleted: true })

    expect(commandMock).toHaveBeenCalledWith("docker", [
      "network",
      "disconnect",
      "--force",
      network,
      "game-server",
    ])
    expect(commandMock).toHaveBeenCalledWith("docker", [
      "network",
      "rm",
      network,
    ])
    expect(commandMock).toHaveBeenCalledWith("docker", ["volume", "rm", volume])
    expect(commandMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["rm", "--force"]),
      expect.anything()
    )
  })
})

describe("explicit database connections", () => {
  it.each(["missing", "unavailable", "healthy"] as const)(
    "handles a %s target without changing server power",
    async (target) => {
      const databaseId = "b".repeat(40)
      const instanceId = "a".repeat(40)
      const set = vi.fn(async () => undefined)
      const reconcile = vi.fn(async () => [
        {
          databaseId: target === "unavailable" ? databaseId : null,
          message: "Network unavailable",
        },
      ])
      const findInstance = vi.fn(async () => ({
        id: instanceId,
        service: "server",
      }))
      const driver = new DatabaseDriver(
        loadConfig({ NODE_ENV: "test" }),
        { findInstance } as unknown as DockerDriver,
        { set, reconcile } as unknown as DatabaseConnections
      )
      const database = {
        id: databaseId,
        connectedInstanceIds: [],
      } as unknown as RelayManagedDatabase
      vi.spyOn(driver, "list")
        .mockResolvedValueOnce(target === "missing" ? [] : [database])
        .mockResolvedValue([
          {
            ...database,
            connectedInstanceIds: target === "healthy" ? [instanceId] : [],
          },
        ])
      const result = driver.updateNetwork({
        databaseId,
        instanceId,
        connected: true,
      })
      if (target === "healthy")
        await expect(result).resolves.toMatchObject({
          connectedInstanceIds: [instanceId],
        })
      else
        await expect(result).rejects.toThrow(
          target === "missing" ? "Database not found" : "Retry the connection"
        )
      expect(set).toHaveBeenCalledTimes(target === "missing" ? 0 : 1)
      expect(reconcile).toHaveBeenCalledTimes(target === "missing" ? 0 : 1)
      expect(commandMock).not.toHaveBeenCalled()
    }
  )
})
