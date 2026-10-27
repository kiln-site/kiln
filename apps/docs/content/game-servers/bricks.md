---
title: Bricks
description: What Bricks and Embers are, how to add community catalogs, and how to write a Brick of your own.
---

A Brick is a recipe for a game server. It's a short YAML file that names the
container image to run, the settings you can change, how those settings reach
the container, and which ports the game uses. Every game server is built from
one Brick.

A Brick is data, not code. The Relay reads it and builds the container from it,
so a new Brick runs on your Relays without updating them.

## Embers

An Ember is a container image built to run game servers for Bricks. Kiln
publishes these Embers from its repository:

| Ember image                                 | What it runs                                    |
| ------------------------------------------- | ----------------------------------------------- |
| `ghcr.io/kiln-site/bricks-java:11`          | Java servers on Java 11.                        |
| `ghcr.io/kiln-site/bricks-java:17`          | Java servers on Java 17.                        |
| `ghcr.io/kiln-site/bricks-java:21`          | Java servers on Java 21.                        |
| `ghcr.io/kiln-site/bricks-java:25`          | Java servers on Java 25.                        |
| `ghcr.io/kiln-site/bricks-steamcmd:latest`  | Steam dedicated servers installed by SteamCMD.  |

A Brick can use one of these or any other container image.

### The Java Ember

On each start, the Java Ember:

1. Downloads the server jar from `KILN_ARTIFACT_URL` to `KILN_ARTIFACT_FILE`,
   if that file isn't there yet.
2. For a Minecraft server, writes `eula=true` to `eula.txt`, and writes a
   starting `server.properties` if there isn't one.
3. Starts Java with a heap of up to 75% of the container's memory limit, any
   extra flags from `KILN_JAVA_ARGS`, and the server arguments from
   `KILN_SERVER_ARGS`.

| Variable                       | What it does                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `KILN_ARTIFACT_URL`            | Required. Where to download the server jar.                                                   |
| `KILN_ARTIFACT_FILE`           | Required. The jar's file name in the server's folder.                                         |
| `KILN_ARTIFACT_SHA256`         | Optional. The jar's SHA-256. The Ember stops if the file doesn't match.                       |
| `KILN_SERVER_KIND`             | `minecraft` (the default) writes `eula.txt` and `server.properties`. Use `application` for anything else. |
| `KILN_JAVA_ARGS`               | Extra JVM flags. Heap flags in it are ignored, and Java argument files like `@flags.txt` stop the start. |
| `KILN_SERVER_ARGS`             | Arguments after the jar. Defaults to `--nogui`; set it to `""` for servers that don't take it. |
| `KILN_JAVA_MAX_RAM_PERCENTAGE` | The heap's share of the container's memory. Defaults to `75.0`.                               |
| `MIN_RAM`                      | The starting heap, passed as `-Xms`. Defaults to `512M`.                                      |
| `KILN_INSTALLATION_MARKER`     | A `.kiln-*` file the Ember creates once the server is installed.                              |

### The SteamCMD Ember

The SteamCMD Ember installs a Steam app on its first start and checks it for
updates on every start after that. Set `KILN_STEAM_APP_ID` to the app's Steam
ID, `KILN_STEAM_EXECUTABLE` to the server's executable inside its install, and
`KILN_SERVER_ARGS` to its arguments. It logs in to Steam anonymously.

## Catalogs

A catalog is a list of Bricks. Hearth shows Kiln's own catalog to everyone, and
marks its Bricks **Verified**. Bricks from other catalogs show as
**Community**.

### Add a catalog

1. Open **Add Game Server**, then **Catalogs** at the bottom of the Brick
   picker.
2. Under **Catalog sources**, enter a GitHub repository as `owner/repo`, or the
   HTTPS URL of a `catalog.yml`.
3. Select **Add**.

For `owner/repo`, Hearth reads `catalog.yml` at the root of the repository's
default branch. Hearth saves a snapshot of the catalog, pinned to the commit it
read for a GitHub catalog, so its Bricks don't change under you.

A catalog you add is yours alone. A platform admin can select **Publish** to
let every account use it, and **Unpublish** to take it back.

Platform admins and people who can add their own Relays can add catalogs.

> [!CAUTION]
> A Brick decides what runs on your Relay: its image, command, and
> environment. Add catalogs and Bricks only from people you trust.

### Use one Brick by URL

To use a single Brick without a catalog:

1. Open **Add Game Server**, then **Custom Brick**.
2. Select **Add Brick** and paste its **Recipe URL**. It must use HTTPS.
3. Select **Save Brick**.

Kiln checks the recipe on the selected Relay and keeps it in your custom
Bricks, ready to provision.

## Write a Brick

The quickest way is to copy the official Brick closest to your game from
[`apps/bricks/recipes`](https://github.com/kiln-site/kiln/tree/main/apps/bricks/recipes)
and change it. This Brick is a trimmed copy of the official Paper Brick, pinned
to Java 21:

```yaml title="my-paper.yml"
format: kiln.brick/v1
metadata:
  id: my-paper
  name: My Paper
  description: Paper on Java 21, for Minecraft 1.20 and 1.21.
  game: Minecraft
  author: You
  tags: [minecraft, java]
variables:
  version:
    type: string
    label: Minecraft version
    description: Paper release to install.
    required: true
    default: "1.21.4"
    rules: { pattern: "^[0-9]+(?:\\.[0-9]+){1,2}$", maxLength: 32 }
  memory:
    type: string
    label: Container memory
    description: Total memory limit; Java uses up to 75% for its heap.
    required: true
    default: 2G
    rules: { pattern: "^[0-9]+[MG]$", maxLength: 12 }
runtime:
  image: ghcr.io/kiln-site/bricks-java:21
  name: Java 21
  environment:
    KILN_IMPLEMENTATION: paper
    KILN_VERSION: "{{ variables.version }}"
    KILN_ARTIFACT_URL: "https://mcjarfiles.com/api/get-jar/servers/paper/{{ variables.version }}"
    KILN_ARTIFACT_FILE: paper.jar
    KILN_INSTALLATION_MARKER: .kiln-ember-installed
    KILN_SERVER_KIND: minecraft
  resources:
    memory: "{{ variables.memory }}"
    pids: 512
  storage: { mount: /server }
console:
  stopCommands: [stop, /stop]
readiness:
  logs: [")! For help, type "]
network:
  mode: minecraft-backend
  primaryPort: game
  ports:
    - { name: game, container: 25565, protocol: tcp }
constraints:
  architectures: [amd64, arm64]
```

Host the file anywhere that serves it over HTTPS, such as a GitHub repository,
then add it by URL or through a catalog.

### What each part does

| Key           | What it does                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format`      | Always `kiln.brick/v1`.                                                                                                                          |
| `metadata`    | The Brick's `id`, `name`, `description`, `game`, and `author`, shown in the Brick picker. Optional: `icon`, `color`, `tags`, and a `documentation` URL. |
| `variables`   | The settings people can change on the **Startup** tab. See [Variables](#variables).                                                             |
| `runtime`     | The `image` to run, a `name` for it, its `environment`, its `resources`, and where the server's folder is mounted under `storage`. Optional: `entrypoint`, `command`, `workingDirectory`, `stopSignal`, and `user`. |
| `console`     | Optional. `stopCommands` lists the console commands that stop the server, so the Relay doesn't restart it after one. See [Crash recovery](/game-servers/power#crash-recovery). |
| `readiness`   | Optional. `logs` lists text that appears in the console once the server has started. Until one appears, for up to two minutes, Hearth shows the server as starting. |
| `network`     | The game's `ports`, which one is the `primaryPort`, and the routing `mode`. See [Ports](#ports).                                                 |
| `constraints` | Optional. `architectures` limits which Relays can run it: `amd64`, `arm64`, or both.                                                            |

The Relay rejects a Brick with any key it doesn't know, so a typo can't
quietly change what runs. The full schema is
[`recipe-v1.schema.json`](https://github.com/kiln-site/kiln/blob/main/apps/bricks/schema/recipe-v1.schema.json),
and the format is described in
[`recipe-v1.md`](https://github.com/kiln-site/kiln/blob/main/apps/bricks/docs/recipe-v1.md).

### Variables

Each variable becomes a field on the **Startup** tab.

- `type` is `string`, `number`, or `boolean`.
- `label` and `description` are what people see.
- `required` and `default` set whether it needs a value, and what it starts as.
- `options` turns it into a list to pick from.
- `rules` checks the value: `pattern` (a regular expression), `min` and `max`
  for numbers, and `minLength` and `maxLength` for strings.
- `sensitive: true` marks a value, such as a password, that Hearth shouldn't
  show openly.

Use a variable's value elsewhere in the Brick with a template. Templates are
replaced as plain text; they can't run code.

```text
{{ variables.<name> }}
{{ brick.id }}
{{ brick.name }}
```

Kiln treats a few variable names specially:

- A variable used as `runtime.resources.memory`, such as `memory` above, is
  replaced by the game server's **Memory** limit.
- A `version` and a `java_version` side by side show as one version and Java
  picker. For the official Minecraft Bricks, picking a version also picks its
  Java version.
- `java_args` mapped to `KILN_JAVA_ARGS` shows beside the flags Kiln manages.

### Ports

Each port has a `name`, the `container` port the game listens on, and a
`protocol`, `tcp` or `udp`. The Relay picks a free public port for each, unless
the port sets a fixed `host` port.

The `mode` is one of:

- `minecraft-backend`, for Minecraft servers and proxies.
- `direct`, which publishes every port as is, for games players connect to
  directly, such as Palworld.

### Limits on what a Brick can do

Whatever a Brick asks for, the Relay runs its container with a read-only root
filesystem, dropped capabilities, `no-new-privileges`, a process limit, and its
own network, and keeps its files inside the game server's own folder. A Brick
can't ask for host folders, extra capabilities, privileged mode, or the Docker
socket.

### Icons

`metadata.icon` points to an SVG, relative to the Brick's file or over HTTPS.
Use a square, transparent SVG of up to 64 KiB with a single-color mark that
uses `currentColor`, and no text. Kiln colors it with `metadata.color`, such as
`"#e67e7e"`.

## Write a catalog

A catalog is a `catalog.yml` that lists Bricks, by paths relative to it or by
URL:

```yaml title="catalog.yml"
format: kiln.catalog/v1
name: My Bricks
author: You
recipes:
  - recipes/my-paper.yml
```

It can also give `docs` and `support` URLs. Put it at the root of a GitHub
repository so people can add it as `owner/repo`.

## Contribute an official Brick

To add a Brick to Kiln's own catalog, follow
[Contributing a Brick](https://github.com/kiln-site/kiln/blob/main/apps/bricks/CONTRIBUTING.md).
In short: copy the closest recipe, give it a lowercase `metadata.id`, pin its
image tag, make every per-server value a variable, add it to
`apps/bricks/catalog.yml`, and run:

```sh title="From the Kiln repository's root"
pnpm --filter @kiln-site/bricks test
```
