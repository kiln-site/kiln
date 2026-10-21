export interface DemoFile {
  saved: string
  // Starts unsaved, so the change markers show before anyone types.
  edited?: string
  // Shown in the footer instead of the text size, as Hearth does for NBT.
  encoding?: string
}

const serverProperties = `#Minecraft server properties
allow-flight=false
difficulty=normal
enable-command-block=false
enable-rcon=false
enforce-secure-profile=true
gamemode=survival
level-name=world
max-players=20
motd=A Minecraft Server
online-mode=true
pvp=true
server-ip=203.0.113.24
server-port=25565
simulation-distance=10
spawn-protection=16
view-distance=10
white-list=false
`

const paperGlobal = `_version: 29
chunk-loading-basic:
  autoconfig-send-distance: true
  player-max-chunk-generate-rate: -1.0
  player-max-chunk-load-rate: 100.0
chunk-system:
  gen-parallelism: default
  io-threads: -1
  worker-threads: -1
misc:
  max-joins-per-tick: 5
  region-file-cache-size: 256
watchdog:
  early-warning-delay: 10000
  early-warning-every: 5000
`

// What Hearth shows for a binary NBT file: the Relay decodes it to SNBT.
const levelDat = `{
\tData: {
\t\tDataVersion: 4189,
\t\tLevelName: "world",
\t\tGameType: 0,
\t\tDifficulty: 2b,
\t\thardcore: 0b,
\t\tallowCommands: 0b,
\t\tDayTime: 1834127L,
\t\tTime: 9021337L,
\t\tSpawnX: 112,
\t\tSpawnY: 71,
\t\tSpawnZ: -48,
\t\training: 0b,
\t\tthundering: 0b,
\t\tVersion: {
\t\t\tId: 4189,
\t\t\tName: "1.21.4",
\t\t\tSeries: "main",
\t\t\tSnapshot: 0b
\t\t},
\t\tWorldGenSettings: {
\t\t\tseed: -4172144997902289642L,
\t\t\tgenerate_features: 1b,
\t\t\tbonus_chest: 0b
\t\t},
\t\tGameRules: {
\t\t\tdoDaylightCycle: "true",
\t\t\tkeepInventory: "false",
\t\t\tplayersSleepingPercentage: "50"
\t\t}
\t}
}
`

const bukkit = `settings:
  allow-end: true
  warn-on-overload: true
  permissions-file: permissions.yml
  update-folder: update
  shutdown-message: Server closed
  minimum-api: none
spawn-limits:
  monsters: 70
  animals: 10
  water-animals: 5
  ambient: 15
chunk-gc:
  period-in-ticks: 600
ticks-per:
  animal-spawns: 400
  monster-spawns: 1
  autosave: 6000
`

const spigot = `settings:
  debug: false
  bungeecord: false
  timeout-time: 60
  restart-on-crash: true
  netty-threads: 4
world-settings:
  default:
    view-distance: default
    mob-spawn-range: 8
    entity-activation-range:
      animals: 32
      monsters: 32
      villagers: 32
config-version: 12
`

const luckPerms = `server: survival
storage-method: h2
sync-minutes: -1
watch-files: true
messaging-service: auto
auto-push-updates: true
temporary-add-behaviour: deny
primary-group-calculation: parents-by-weight
`

const ops = `[
  {
    "uuid": "5d1f9a3c-8b2e-4c71-a0f4-2e9b7c6d1a08",
    "name": "mossy_mae",
    "level": 4,
    "bypassesPlayerLimit": false
  }
]
`

const whitelist = `[
  { "uuid": "5d1f9a3c-8b2e-4c71-a0f4-2e9b7c6d1a08", "name": "mossy_mae" },
  { "uuid": "e2a7c410-93bd-4f8e-b1c5-7d2e0a9f6b31", "name": "redstone_ryan" },
  { "uuid": "0b9d4e7a-1c3f-4a62-8e5b-f4a1c7d2e930", "name": "cobblequeen" }
]
`

const eula = `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).
eula=true
`

const latestLog = `[09:12:04] [Server thread/INFO]: Starting minecraft server version 1.21.4
[09:12:04] [Server thread/INFO]: Loading properties
[09:12:05] [Server thread/INFO]: This server is running Paper version 1.21.4-232-main
[09:12:05] [Server thread/INFO]: Default game type: SURVIVAL
[09:12:06] [Server thread/INFO]: Preparing level "world"
[09:12:08] [Server thread/INFO]: Done (3.914s)! For help, type "help"
[09:14:31] [User Authenticator #0/INFO]: UUID of player mossy_mae is 5d1f9a3c-8b2e-4c71-a0f4-2e9b7c6d1a08
[09:14:31] [Server thread/INFO]: mossy_mae joined the game
`

export const demoFiles: Record<string, DemoFile> = {
  "server.properties": {
    saved: serverProperties,
    edited: serverProperties
      .replace("max-players=20", "max-players=40")
      .replace(
        "motd=A Minecraft Server",
        "motd=\\u00A76Survival SMP \\u00A77| season 4"
      )
      .replace("white-list=false", "white-list=true"),
  },
  "banned-ips.json": { saved: "[]\n" },
  "banned-players.json": { saved: "[]\n" },
  "bukkit.yml": { saved: bukkit },
  "commands.yml": {
    saved:
      "command-block-overrides: []\nignore-vanilla-permissions: false\naliases:\n  icanhasbukkit:\n  - version $1-\n",
  },
  "config/paper-global.yml": { saved: paperGlobal },
  "config/paper-world-defaults.yml": {
    saved:
      "_version: 31\nchunks:\n  auto-save-interval: default\n  max-auto-save-chunks-per-tick: 24\nentities:\n  spawning:\n    per-player-mob-spawns: true\n",
  },
  "eula.txt": { saved: eula },
  "logs/latest.log": { saved: latestLog },
  "ops.json": { saved: ops },
  "plugins/LuckPerms/config.yml": { saved: luckPerms },
  "spigot.yml": { saved: spigot },
  "usercache.json": {
    saved:
      '[{"name":"mossy_mae","uuid":"5d1f9a3c-8b2e-4c71-a0f4-2e9b7c6d1a08","expiresOn":"2026-11-19 09:14:31 +0000"}]\n',
  },
  "whitelist.json": { saved: whitelist },
  "world/level.dat": { saved: levelDat, encoding: "1,284 B GZIP NBT" },
}

// Everything the tree lists. Files missing from demoFiles are binary, and
// open the way Hearth shows a file it can't edit.
export const demoTreePaths = [
  ...Object.keys(demoFiles),
  "cache/mojang_1.21.4.jar",
  "libraries/com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar",
  "logs/2026-10-19-1.log.gz",
  "paper.jar",
  "plugins/EssentialsX-2.20.1.jar",
  "plugins/LuckPerms-Bukkit-5.4.145.jar",
  "versions/1.21.4/paper-1.21.4.jar",
  "world/region/r.0.0.mca",
  "world/region/r.-1.0.mca",
  "world_nether/DIM-1/region/r.0.0.mca",
  "world_the_end/DIM1/region/r.0.0.mca",
]

export const initialFilePath = "server.properties"
