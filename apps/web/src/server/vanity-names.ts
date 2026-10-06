import type { RelayInstance } from "@workspace/contracts"

import { vanityLabelAllowed } from "@/lib/domain-schemas"

const adjectives = [
  "amber",
  "ancient",
  "ashen",
  "brave",
  "bright",
  "cobalt",
  "cosmic",
  "crimson",
  "deep",
  "dusky",
  "ember",
  "fabled",
  "frost",
  "golden",
  "hidden",
  "iron",
  "jade",
  "lucky",
  "lunar",
  "mighty",
  "misty",
  "neon",
  "quiet",
  "rapid",
  "royal",
  "silver",
  "solar",
  "storm",
  "verdant",
  "wild",
  "winter",
  "young",
] as const

const nouns = [
  "anvil",
  "bastion",
  "beacon",
  "citadel",
  "cove",
  "craft",
  "dragon",
  "forge",
  "grove",
  "harbor",
  "haven",
  "hollow",
  "isle",
  "keep",
  "lantern",
  "mesa",
  "mine",
  "moon",
  "nexus",
  "peak",
  "portal",
  "quarry",
  "realm",
  "ridge",
  "river",
  "spire",
  "summit",
  "torch",
  "vault",
  "village",
  "wilds",
  "works",
] as const

export function generateVanityCandidates(
  blacklistPatterns: ReadonlyArray<string>,
  count = 24,
  choose: (maximum: number) => number = randomIndex
): Array<string> {
  const candidates = new Set<string>()
  for (
    let attempt = 0;
    attempt < count * 16 && candidates.size < count;
    attempt += 1
  ) {
    const adjective = adjectives[choose(adjectives.length)]
    const noun = nouns[choose(nouns.length)]
    if (!adjective || !noun) continue
    const base = `${adjective}-${noun}`
    const candidate = candidates.has(base)
      ? `${base}-${choose(900) + 100}`
      : base
    if (vanityLabelAllowed(candidate, blacklistPatterns)) {
      candidates.add(candidate)
    }
  }
  if (candidates.size === 0) {
    throw new Error("The blacklist excludes every generated vanity name")
  }
  return [...candidates]
}

function randomIndex(maximum: number): number {
  return Math.floor(Math.random() * maximum)
}

function defaultSrvService(game: string): string {
  const normalized = game
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32)
  return normalized || "game"
}

export function managedDomainSrvConfiguration(
  instance: Pick<
    RelayInstance,
    | "brickNetworkMode"
    | "brickPrimaryPortProtocol"
    | "brickSupportsSrv"
    | "game"
  >
): { protocol: "tcp" | "udp"; service: string } | null {
  const minecraftNetwork = instance.brickNetworkMode === "minecraft-backend"
  if (!instance.brickSupportsSrv && !minecraftNetwork) return null

  const protocol =
    instance.brickPrimaryPortProtocol === "tcp" ||
    instance.brickPrimaryPortProtocol === "udp"
      ? instance.brickPrimaryPortProtocol
      : instance.brickPrimaryPortProtocol === "both" && minecraftNetwork
        ? "tcp"
        : null
  return protocol
    ? { protocol, service: defaultSrvService(instance.game) }
    : null
}
