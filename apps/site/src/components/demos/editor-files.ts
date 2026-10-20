export interface DemoFile {
  name: string
  path: string
  saved: string
  // Starts unsaved, so the change markers show before anyone types.
  edited?: string
}

const serverProperties = `#Minecraft server properties
allow-flight=false
difficulty=normal
enable-command-block=false
enable-rcon=false
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

const questChapter = `{
\tid: "4D2B0C9E1F7A3E21"
\tgroup: ""
\torder_index: 0
\tfilename: "getting_started"
\ttitle: "Getting Started"
\ticon: "minecraft:oak_sapling"
\tquests: [
\t\t{
\t\t\tid: "1A6F3C8B2D9E4F10"
\t\t\ttitle: "Punch a tree"
\t\t\tx: 0.0d
\t\t\ty: 0.0d
\t\t\ttasks: [{ id: "6E1B", type: "item", item: "minecraft:oak_log", count: 4L }]
\t\t\trewards: [{ id: "7C2D", type: "xp", xp: 25 }]
\t\t}
\t]
}
`

export const demoFiles: Array<DemoFile> = [
  {
    name: "server.properties",
    path: "server.properties",
    saved: serverProperties,
    edited: serverProperties
      .replace("max-players=20", "max-players=40")
      .replace(
        "motd=A Minecraft Server",
        "motd=\\u00A76Survival SMP \\u00A77| season 4"
      )
      .replace("view-distance=10", "view-distance=12")
      .replace("white-list=false", "white-list=true"),
  },
  {
    name: "paper-global.yml",
    path: "config/paper-global.yml",
    saved: paperGlobal,
  },
  {
    name: "getting_started.snbt",
    path: "config/ftbquests/quests/chapters/getting_started.snbt",
    saved: questChapter,
  },
]
