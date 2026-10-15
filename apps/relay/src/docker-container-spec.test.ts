import { Effect, Result } from "effect"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import {
  containerCreateBody,
  createContainer,
} from "./docker-container-spec.js"
import { DockerEngine, DockerEngineError } from "./docker-engine.js"
import { fakeDocker } from "./test/docker.js"
import recorded from "./test/docker-cli-create-bodies.json" with { type: "json" }

// Container config and labels are read by other Kiln versions, so containers
// are created with the same body the docker CLI (29.8.2) sent for the flags
// Relay passed it. The fixtures are those bodies, recorded from the CLI.
describe("container create bodies", () => {
  it("match the CLI's for a game server's flags", () => {
    expect(
      containerCreateBody({
        binds: ["/srv/kiln:/server"],
        capDrop: ["ALL"],
        command: ["-c", "sleep 1"],
        entrypoint: "/bin/sh",
        env: { A: "1", B: "two words" },
        hostname: "kiln-server",
        image: "alpine:3.21",
        interactive: true,
        labels: { "kiln.json": '{"a":[1]}', "kiln.x": "1" },
        memory: "2048m",
        memoryReservation: "1536m",
        memorySwap: "2048m",
        name: "kiln-server",
        network: { aliases: ["kiln-server"], name: "kiln-game" },
        pidsLimit: 512,
        ports: [
          { containerPort: 25565, hostPort: 30001, protocol: "tcp" },
          { containerPort: 19132, hostPort: 30002, protocol: "udp" },
        ],
        readOnly: true,
        restart: "no",
        securityOpt: ["no-new-privileges:true"],
        stopSignal: "SIGINT",
        tmpfs: { "/tmp": "rw,exec,nosuid,nodev,size=128m" },
        tty: true,
        user: "1000:1000",
        workdir: "/server",
      })
    ).toEqual(recorded.game)
  })

  it("match the CLI's for a database's health check and volume", () => {
    expect(
      containerCreateBody({
        command: ["redis-server", "--appendonly", "yes"],
        env: { X: "1" },
        healthcheck: {
          command: 'pg_isready -U "$POSTGRES_USER"',
          interval: "5s",
          retries: 24,
          startPeriod: "10s",
          timeout: "3s",
        },
        hostname: "db",
        image: "alpine:3.21",
        labels: { l: "1" },
        mounts: [{ source: "kiln-db-data", target: "/data", type: "volume" }],
        name: "kiln-db",
        network: { aliases: ["db"], name: "kiln-db-network" },
        restart: "unless-stopped",
      })
    ).toEqual(recorded.database)
  })

  it("match the CLI's for host networking, capabilities, and devices", () => {
    expect(
      containerCreateBody({
        binds: ["/srv/kiln:/var/lib/tailscale"],
        capAdd: ["NET_ADMIN", "NET_RAW"],
        command: ["sleep", "600"],
        devices: ["/dev/null:/dev/fakenull"],
        env: {
          TS_AUTH_ONCE: "true",
          TS_KUBE_SECRET: "",
          TS_AUTHKEY: "secret-key",
        },
        image: "alpine:3.21",
        labels: { "kiln.relay.owner": "x" },
        name: "kiln-host-tailscale",
        network: "host",
        restart: "unless-stopped",
      })
    ).toEqual(recorded.tailscale)
  })

  it("match the CLI's for a fixed address, sysctls, and resource limits", () => {
    expect(
      containerCreateBody({
        command: ["sleep", "600"],
        hostname: "stack",
        image: "alpine:3.21",
        memory: "64m",
        memoryReservation: "16m",
        memorySwap: "64m",
        name: "kiln-tailscale",
        network: { ipv4Address: "10.231.7.2", name: "kiln-tailscale-network" },
        pidsLimit: 128,
        restart: "unless-stopped",
        sysctls: { "net.ipv4.ip_forward": "1" },
      })
    ).toEqual(recorded.stack)
  })

  it("fails a create with an invalid size as a Docker error, creating nothing", async () => {
    const engine = new DockerEngine(await fakeDocker.listen())
    onTestFinished(() => fakeDocker.reset())

    const outcome = await Effect.runPromise(
      Effect.result(
        createContainer(engine, {
          image: "alpine:3.21",
          memory: "lots",
          name: "kiln-invalid",
        })
      )
    )

    expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(
      DockerEngineError
    )
    expect(fakeDocker.container("kiln-invalid")).toBeUndefined()
  })

  it("match the CLI's for the update helper", () => {
    expect(
      containerCreateBody({
        command: ["echo", "done"],
        env: { KILN_UPDATE_DATA_DIR: "/data/updates" },
        healthcheck: "none",
        image: "alpine:3.21",
        labels: { "io.kiln.update-helper": "true" },
        name: "kiln-updater",
        volumesFrom: ["kiln-relay"],
      })
    ).toEqual(recorded.helper)
  })
})
