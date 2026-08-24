import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { Effect } from "effect"

const commandMock = vi.hoisted(() => vi.fn())

vi.mock("./command.js", () => ({ command: commandMock }))

import { loadConfig } from "./config.js"
import type { BrickCatalog } from "./bricks.js"
import { DockerDriver, MAX_CONSOLE_HISTORY_LINES } from "./docker.js"
import type { RelayStateStore } from "./effect/state.js"

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  commandMock.mockReset()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

describe("rediscovered startup readiness", () => {
  it("recovers and persists readyAt beyond the recent console tail", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-readiness-"))
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      KILN_RELAY_RESOURCE_NAMESPACE: "readiness-test",
      NODE_ENV: "test",
    })
    const id = "a".repeat(40)
    const serverDirectory = join(config.rootDirectory, id)
    await mkdir(serverDirectory, { recursive: true })

    const startedAt = "2026-08-21T20:39:57.000Z"
    const readyAt = "2026-08-21T20:40:19.000Z"
    const lines = [
      `${readyAt} Done (21.758s)! For help, type "help"`,
      ...Array.from({ length: MAX_CONSOLE_HISTORY_LINES + 1 }, (_, index) => {
        const timestamp = new Date(
          Date.parse(readyAt) + index + 1
        ).toISOString()
        return `${timestamp} later output ${index}`
      }),
    ]
    const container = {
      Config: {
        Image: "kiln-ember:test",
        Labels: {
          "kiln.brick.snapshot-sha256": "b".repeat(64),
          "kiln.brick.source": "https://bricks.example.test/paper.yml",
          "kiln.instance.directory": id,
          "kiln.instance.disk-bytes": String(1024 * 1024 * 1024),
          "kiln.instance.memory-bytes": String(1024 * 1024 * 1024),
          "kiln.instance.mount": "/server",
          "kiln.relay.managed": "true",
          "kiln.relay.owner": "readiness-test",
          "kiln.relay.owned": "true",
          "kiln.server.id": id,
        },
        Tty: false,
      },
      HostConfig: {
        Memory: 1024 * 1024 * 1024,
        PortBindings: {},
        RestartPolicy: { Name: "no" },
      },
      Id: "container-id",
      Mounts: [{ Destination: "/server", RW: true, Source: serverDirectory }],
      Name: "/readiness-test-kiln-aaaaaaaa",
      NetworkSettings: { Networks: {}, Ports: {} },
      State: {
        ExitCode: 0,
        FinishedAt: "0001-01-01T00:00:00Z",
        OOMKilled: false,
        Restarting: false,
        Running: true,
        StartedAt: startedAt,
        Status: "running",
      },
    }
    const storedReadySessions = new Map<
      string,
      { instanceId: string; readyAt: string; startedAt: string }
    >()
    const recipeMock = vi.fn(async () => ({
      readiness: { logs: [")! For help, type "] },
    }))
    const bricks = { recipe: recipeMock } as unknown as BrickCatalog
    const state = {
      deleteReadySession: (instanceId: string) =>
        Effect.sync(() => {
          storedReadySessions.delete(instanceId)
        }),
      listReadySessions: () =>
        Effect.succeed([...storedReadySessions.values()]),
      setReadySession: (session: {
        instanceId: string
        readyAt: string
        startedAt: string
      }) =>
        Effect.sync(() => {
          storedReadySessions.set(session.instanceId, session)
        }),
    } as unknown as RelayStateStore["Service"]

    commandMock.mockImplementation(
      async (
        _executable: string,
        arguments_: Array<string>
      ): Promise<{ stderr: string; stdout: string }> => {
        if (arguments_[0] === "container" && arguments_[1] === "ls") {
          return { stderr: "", stdout: `${container.Id}\n` }
        }
        if (arguments_[0] === "inspect") {
          return { stderr: "", stdout: JSON.stringify([container]) }
        }
        if (arguments_[0] === "logs") {
          const tailIndex = arguments_.indexOf("--tail")
          const selected =
            tailIndex === -1
              ? lines
              : lines.slice(-Number(arguments_[tailIndex + 1]))
          return { stderr: "", stdout: selected.join("\n") }
        }
        return { stderr: "", stdout: "" }
      }
    )

    const [instance] = await new DockerDriver(
      config,
      null,
      bricks,
      state
    ).inspectInstances()

    expect(instance?.observedState).toBe("running")
    expect(instance?.readyAt).toBe(readyAt)
    expect(storedReadySessions.get(id)).toEqual({
      instanceId: id,
      readyAt,
      startedAt,
    })
    expect(recipeMock).toHaveBeenCalledWith(
      "https://bricks.example.test/paper.yml",
      "b".repeat(64)
    )
    expect(commandMock).toHaveBeenCalledWith(
      "docker",
      [
        "logs",
        "--timestamps",
        "--since",
        startedAt,
        "--until",
        "2026-08-21T20:41:57.000Z",
        container.Id,
      ],
      { timeout: 15_000 }
    )

    const logCallsBeforeRestart = commandMock.mock.calls.filter(
      ([, arguments_]) => arguments_[0] === "logs"
    ).length
    const [afterRelayRestart] = await new DockerDriver(
      config,
      null,
      bricks,
      state
    ).inspectInstances()

    expect(afterRelayRestart?.observedState).toBe("running")
    expect(afterRelayRestart?.readyAt).toBe(readyAt)
    expect(recipeMock).toHaveBeenCalledTimes(1)
    expect(
      commandMock.mock.calls.filter(
        ([, arguments_]) => arguments_[0] === "logs"
      )
    ).toHaveLength(logCallsBeforeRestart)
  })
})
