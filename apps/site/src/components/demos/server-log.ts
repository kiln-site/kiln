import type { RelayConsoleLevel, RelayConsoleLine } from "@workspace/contracts"

// A deterministic Paper server log, so the demo reads like a real busy
// server without shipping a recording.
const players = [
  "mossy_mae",
  "redstone_ryan",
  "cobblequeen",
  "tnt_tom",
  "pixelpaws",
  "Steve_42",
  "glowberry",
  "deepslate_dan",
  "amethyst_ari",
  "nether_nik",
  "creeperkeeper",
  "oak_and_ash",
]
const chat = [
  "anyone want to raid the ocean monument?",
  "lag is gone since the move, nice",
  "who left the furnace on at spawn lol",
  "trading mending books at the village",
  "brb, dinner",
  "found a mineshaft under the base",
  "the farm finally works",
  "gg",
  "how do i set a home again",
  "server feels so fast now",
]
const advancements = [
  "Stone Age",
  "Getting an Upgrade",
  "Diamonds!",
  "We Need to Go Deeper",
  "Monster Hunter",
  "Sweet Dreams",
  "Hot Topic",
  "Ice Bucket Challenge",
]
const deaths = [
  "was blown up by Creeper",
  "fell from a high place",
  "tried to swim in lava",
  "was slain by Zombie",
  "drowned",
  "was shot by Skeleton",
]

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

type Random = ReturnType<typeof createRandom>

function pick<T>(random: Random, items: ReadonlyArray<T>): T {
  return items[Math.floor(random() * items.length)]!
}

function coordinate(random: Random, spread: number) {
  return (random() * spread * 2 - spread).toFixed(2)
}

function nextEntry(random: Random): [RelayConsoleLevel, string] {
  const roll = random()
  const player = pick(random, players)
  if (roll < 0.22) return ["info", `<${player}> ${pick(random, chat)}`]
  if (roll < 0.32) return ["info", `${player} joined the game`]
  if (roll < 0.42) return ["info", `${player} left the game`]
  if (roll < 0.5)
    return [
      "info",
      `${player} has made the advancement [${pick(random, advancements)}]`,
    ]
  if (roll < 0.56) return ["info", `${player} ${pick(random, deaths)}`]
  if (roll < 0.66)
    return [
      "info",
      `${player}[/10.0.${Math.floor(random() * 255)}.${Math.floor(random() * 255)}:${49152 + Math.floor(random() * 16000)}] logged in with entity id ${Math.floor(random() * 90000)} at ([world]${coordinate(random, 3000)}, ${Math.floor(random() * 120) - 20}.0, ${coordinate(random, 3000)})`,
    ]
  if (roll < 0.8)
    return [
      "debug",
      `Saved chunk [${Math.floor(random() * 400) - 200}, ${Math.floor(random() * 400) - 200}] in ${(random() * 4).toFixed(2)}ms`,
    ]
  if (roll < 0.88) return ["info", "Saving the game (this may take a moment!)"]
  if (roll < 0.94)
    return [
      "info",
      `Saved the game in ${Math.floor(40 + random() * 160)}ms, ${Math.floor(800 + random() * 4000)} chunks across 3 worlds`,
    ]
  if (roll < 0.985)
    return [
      "warn",
      `${player} moved too quickly! ${coordinate(random, 12)},${coordinate(random, 4)},${coordinate(random, 12)}`,
    ]
  return [
    "error",
    `Could not pass event EntityDamageByEntityEvent to SimpleClaims v2.4.1: claim at (${Math.floor(random() * 2000)}, ${Math.floor(random() * 2000)}) has no owner`,
  ]
}

export function createServerLog(seed = 7) {
  const random = createRandom(seed)
  let nextId = 0

  // Hearth hides timestamps by default; leaving them out keeps a million
  // lines light.
  function line(level: RelayConsoleLevel, text: string): RelayConsoleLine {
    nextId += 1
    return {
      id: String(nextId),
      level,
      text,
      timestamp: null,
    }
  }

  return {
    // Generates lines in place so a large history allocates once.
    fill(lines: Array<RelayConsoleLine>, count: number) {
      for (let index = 0; index < count; index += 1) {
        const [level, text] = nextEntry(random)
        lines.push(line(level, text))
      }
    },
    next(): RelayConsoleLine {
      const [level, text] = nextEntry(random)
      return line(level, text)
    },
    line,
  }
}
