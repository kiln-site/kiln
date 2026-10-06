import { loadConfig } from "../config"
import type { RelayConfig, RelayInstanceConfig } from "../config"

/** A Relay config loaded the same way production loads it, rooted at `dataDirectory`. */
export function testRelayConfig(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = {}
): RelayConfig {
  return loadConfig({
    KILN_RELAY_DATA_DIR: dataDirectory,
    KILN_RELAY_HOST: "relay.test",
    NODE_ENV: "test",
    ...environment,
  })
}

export function testInstance(
  overrides: Partial<RelayInstanceConfig> = {}
): RelayInstanceConfig {
  const id = overrides.id ?? "instance-1"
  return {
    connectAddress: "relay.test",
    directory: id,
    game: "minecraft",
    id,
    implementation: "paper",
    javaVersion: "21",
    limits: { diskBytes: 0, memoryBytes: 0 },
    managedByRelay: true,
    name: "Instance One",
    ports: [],
    service: `kiln-${id}`,
    shortId: id.slice(0, 10),
    tailscale: { enabled: false },
    version: "1.21.8",
    ...overrides,
  }
}
