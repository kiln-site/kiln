import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
} from "node:http"
import { hostname } from "node:os"
import type { AddressInfo } from "node:net"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { DesktopUnavailableError } from "./desktop-backend.js"
import { VoxlDesktop } from "./desktop-voxl.js"
import { Desktop } from "./desktop.js"
import { exclusive, laneKeys, OperationLanes } from "./operation-lanes.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"

const VOXL_PORT = 47901
const x11 = [
  "displayManager=yes",
  "user=ada",
  "class=user",
  "desktop=GNOME",
  "status=x11",
  "uid=1000",
  "gid=1000",
  "display=:0",
  "xauthority=/run/user/1000/gdm/Xauthority",
  "pulse=yes",
].join("\n")
const wayland = "displayManager=yes\nuser=ada\nclass=user\nstatus=wayland\n"

const servers: Array<Server> = []

const desktopOn = (
  config: ConstructorParameters<typeof VoxlDesktop>[0] & {
    readonly hostAccess: boolean
  },
  runScript: () => Promise<string>,
  lanes: OperationLanes
) => new Desktop([new VoxlDesktop(config, { runScript })], config, lanes)

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections()
          server.close(resolve)
        })
    )
  )
})

const listen = (server: Server, port: number) =>
  new Promise<number>((resolve) => {
    servers.push(server)
    server.listen(port, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port)
    )
  })

// Stands in for voxl where the Relay reaches it, noting what it was sent.
async function fakeVoxl() {
  const upgrades: Array<IncomingHttpHeaders> = []
  const state = { unreachable: false }
  const server = createServer((_request, response) => {
    // Answers as an unreachable streamer does, once: what replaces it is fine.
    response.statusCode = state.unreachable ? 503 : 200
    state.unreachable = false
    response.end("ok")
  })
  server.on("upgrade", (incoming, socket) => {
    upgrades.push(incoming.headers)
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
    )
  })
  await listen(server, VOXL_PORT)
  const stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(resolve)
    })
  return { state, stop, upgrades }
}

async function harness(script = x11) {
  const harnessed = await relayHarness()
  const config = { ...harnessed.config, desktopImage: "example/voxl:test" }
  fakeDocker.addContainer({ name: hostname(), running: true })
  fakeDocker.images.set(config.desktopImage, {})
  const lanes = new OperationLanes()
  const desktop = desktopOn(config, async () => script, lanes)
  const server = createServer()
  desktop.attachServer(server)
  const port = await listen(server, 0)
  return { config, desktop, lanes, port }
}

// The status a WebSocket handshake to `path` gets.
const handshake = (port: number, path: string) =>
  new Promise<number>((resolve, reject) => {
    const outgoing = request({
      headers: {
        connection: "Upgrade",
        origin: "https://attacker.example",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        upgrade: "websocket",
      },
      host: "127.0.0.1",
      path,
      port,
    })
    outgoing.once("upgrade", (response, socket) => {
      socket.destroy()
      resolve(response.statusCode ?? 0)
    })
    outgoing.once("response", (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    outgoing.once("error", reject)
    outgoing.end()
  })

describe("the node's desktop", () => {
  it("streams as the signed-in person, reachable only through the Relay", async () => {
    await fakeVoxl()
    const { desktop } = await harness()
    await desktop.attach()
    const streamer = fakeDocker.container(`${TEST_NAMESPACE}-kiln-desktop`)
    expect(streamer?.state.running).toBe(true)
    expect(streamer?.networkMode).toMatch(/^container:/u)
    expect(streamer?.portBindings).toEqual({})
    expect(streamer?.cmd).toContain("--addr=127.0.0.1")
    expect(streamer?.cmd).toContain("--file-transfers=none")
  })

  it("refuses a stream without a live ticket", async () => {
    const { upgrades } = await fakeVoxl()
    const { desktop, port } = await harness()
    const { ticket } = await desktop.attach()
    const unknown = "a".repeat(43)
    expect(await handshake(port, `/v1/desktop/${unknown}/ws`)).toBe(403)
    desktop.detach(ticket)
    expect(await handshake(port, `/v1/desktop/${ticket}/ws`)).toBe(403)
    expect(upgrades).toEqual([])
  })

  it("carries a stream with voxl's password, and none of the browser's origin", async () => {
    const { upgrades } = await fakeVoxl()
    const { desktop, port } = await harness()
    const { ticket } = await desktop.attach()
    expect(await handshake(port, `/v1/desktop/${ticket}/ws`)).toBe(101)
    expect(upgrades).toHaveLength(1)
    expect(upgrades[0]?.authorization).toMatch(/^Bearer .{43}$/u)
    expect(upgrades[0]?.origin).toBeUndefined()
  })

  it("replaces a streamer that runs but no longer answers, as after a Relay restart", async () => {
    const voxl = await fakeVoxl()
    const { desktop } = await harness()
    await desktop.attach()
    const name = `${TEST_NAMESPACE}-kiln-desktop`
    const stranded = fakeDocker.container(name)?.id
    await desktop.attach()
    expect(fakeDocker.container(name)?.id).toBe(stranded)
    voxl.state.unreachable = true
    await desktop.attach()
    expect(fakeDocker.container(name)?.state.running).toBe(true)
    expect(fakeDocker.container(name)?.id).not.toBe(stranded)
  })

  it("removes a streamer an earlier Relay process left, with nobody watching", async () => {
    await fakeVoxl()
    const { config, desktop, lanes } = await harness()
    await desktop.attach()
    const name = `${TEST_NAMESPACE}-kiln-desktop`
    expect(fakeDocker.container(name)).toBeDefined()
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    const restarted = desktopOn(config, async () => x11, lanes)
    const server = createServer()
    servers.push(server)
    restarted.attachServer(server)
    vi.advanceTimersByTime(6 * 60_000)
    vi.useRealTimers()
    await vi.waitFor(() => expect(fakeDocker.container(name)).toBeUndefined())
  })

  it("ends a ticket once its streamer is gone, so the page attaches again", async () => {
    const voxl = await fakeVoxl()
    const { desktop, port } = await harness()
    const { ticket } = await desktop.attach()
    await voxl.stop()
    await handshake(port, `/v1/desktop/${ticket}/ws`).catch(() => 0)
    await vi.waitFor(() =>
      expect(desktop.heartbeat([ticket]).tickets).toEqual([])
    )
  })

  it("lets a ticket lapse without Hearth's heartbeats, and keeps it with them", async () => {
    await fakeVoxl()
    const { desktop } = await harness()
    const { ticket } = await desktop.attach()
    const now = Date.now()
    vi.useFakeTimers({ now, toFake: ["Date"] })
    vi.setSystemTime(now + 50_000)
    expect(desktop.heartbeat([ticket]).tickets).toEqual([ticket])
    vi.setSystemTime(now + 100_000)
    expect(desktop.heartbeat([ticket]).tickets).toEqual([ticket])
    vi.setSystemTime(now + 161_000)
    expect(desktop.heartbeat([ticket]).tickets).toEqual([])
  })

  it("doesn't trust what the session's processes report", async () => {
    await fakeVoxl()
    const name = `${TEST_NAMESPACE}-kiln-desktop`
    // Each stands in for detection output a person's own processes shaped.
    for (const script of [
      `${x11}\nuid=0\ngid=0`,
      x11.replace("uid=1000", "uid=0"),
      x11.replace("display=:0", "display=:0/../../var/run"),
    ]) {
      const { desktop } = await harness(script)
      await expect(desktop.attach()).rejects.toBeInstanceOf(
        DesktopUnavailableError
      )
      expect(fakeDocker.container(name)).toBeUndefined()
      fakeDocker.containers.clear()
    }
    const { desktop } = await harness(
      x11.replace(
        "xauthority=/run/user/1000/gdm/Xauthority",
        "xauthority=/run/user/1000/../../docker.sock"
      )
    )
    await desktop.attach()
    const streamer = fakeDocker.container(name)
    expect(streamer?.state.running).toBe(true)
    expect(
      streamer?.mounts.map((mount) => mount.source).join(" ")
    ).not.toContain("docker.sock")
  })

  it("ends streams when the Relay pauses, and takes no input until it resumes", async () => {
    const { upgrades } = await fakeVoxl()
    const { desktop, lanes, port } = await harness()
    let reachedHost = false
    const { ticket } = await desktop.attach()
    lanes.setPaused(true)
    expect(await handshake(port, `/v1/desktop/${ticket}/ws`)).toBe(403)
    expect(upgrades).toEqual([])
    desktop.closeStreams()
    expect(desktop.heartbeat([ticket]).tickets).toEqual([])
    const paused = desktopOn(
      { ...(await relayHarness()).config, desktopImage: "example/voxl:test" },
      async () => {
        reachedHost = true
        return x11
      },
      lanes
    )
    expect((await paused.read()).status).toBe("paused")
    expect(reachedHost).toBe(false)
  })

  it("keeps a streamer someone attached to while its idle removal waited", async () => {
    await fakeVoxl()
    const { desktop, lanes } = await harness()
    await desktop.attach()
    const name = `${TEST_NAMESPACE}-kiln-desktop`
    const running = fakeDocker.container(name)?.id
    let release = () => {}
    const held = Effect.runPromise(
      lanes.run(
        { label: "relay.desktop.attach", locks: [exclusive(laneKeys.desktop)] },
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              release = resolve
            })
        )
      )
    )
    const { ticket } = await desktop.attach()
    desktop.detach(ticket)
    vi.useFakeTimers({
      now: Date.now() + 10 * 60_000,
      toFake: ["Date", "setInterval", "clearInterval"],
    })
    const server = createServer()
    servers.push(server)
    desktop.attachServer(server)
    vi.advanceTimersByTime(20_000)
    vi.useRealTimers()
    const { ticket: kept } = await desktop.attach()
    release()
    await held
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fakeDocker.container(name)?.id).toBe(running)
    expect(desktop.heartbeat([kept]).tickets).toEqual([kept])
  })

  it("starts nothing for a desktop it can't stream", async () => {
    const { desktop } = await harness(wayland)
    await expect(desktop.attach()).rejects.toBeInstanceOf(
      DesktopUnavailableError
    )
    expect(
      fakeDocker.container(`${TEST_NAMESPACE}-kiln-desktop`)
    ).toBeUndefined()
  })

  it("doesn't take over another container with the streamer's name", async () => {
    await fakeVoxl()
    const { desktop } = await harness()
    const foreign = fakeDocker.addContainer({
      name: `${TEST_NAMESPACE}-kiln-desktop`,
      labels: { "kiln.relay.owner": TEST_NAMESPACE },
    })
    await expect(desktop.attach()).rejects.toThrow("not owned")
    await desktop.remove()
    expect(fakeDocker.container(foreign.id)).toBe(foreign)
  })
})
