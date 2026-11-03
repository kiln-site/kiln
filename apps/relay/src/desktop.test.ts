import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
} from "node:http"
import { hostname } from "node:os"
import type { AddressInfo } from "node:net"

import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { Desktop, DesktopUnavailableError } from "./desktop.js"
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
  "pulse=/run/user/1000/pulse/native",
].join("\n")
const wayland = "displayManager=yes\nuser=ada\nclass=user\nstatus=wayland\n"

const servers: Array<Server> = []

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
  return { state, upgrades }
}

async function harness(script = x11) {
  const { config } = await relayHarness()
  fakeDocker.addContainer({ name: hostname(), running: true })
  fakeDocker.images.set(config.desktopImage, {})
  const desktop = new Desktop(config, { runScript: async () => script })
  const server = createServer()
  desktop.attachServer(server)
  const port = await listen(server, 0)
  return { config, desktop, port }
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
    const { config, desktop } = await harness()
    await desktop.attach()
    const name = `${TEST_NAMESPACE}-kiln-desktop`
    expect(fakeDocker.container(name)).toBeDefined()
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    const restarted = new Desktop(config, { runScript: async () => x11 })
    const server = createServer()
    servers.push(server)
    restarted.attachServer(server)
    vi.advanceTimersByTime(6 * 60_000)
    vi.useRealTimers()
    await vi.waitFor(() => expect(fakeDocker.container(name)).toBeUndefined())
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
