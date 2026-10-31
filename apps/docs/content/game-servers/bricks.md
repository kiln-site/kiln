---
title: Bricks
description: Add community catalogs or a single Brick, and write a Brick of your own.
---

A Brick is a game server's recipe: a YAML file naming the container image,
the settings you can change, and the game's ports.

> [!CAUTION]
> A Brick decides what runs on your Relay. Add catalogs and Bricks only from
> people you trust.

## Add a catalog

1. Open **Add Game Server**, then **Catalogs** at the bottom of the Brick
   picker.
2. Under **Catalog sources**, enter a GitHub `owner/repo` or the HTTPS URL of a
   `catalog.yml`.
3. Select **Add**.

Hearth saves a snapshot, pinned to the GitHub commit, so its **Community**
Bricks don't change under you. Platform admins and people who can add their
own Relays can add catalogs, and a platform admin can **Publish** one to every
account.

## Add one Brick by URL

Open **Add Game Server**, then **Custom Brick**, select **Add Brick**, paste
its HTTPS **Recipe URL**, and select **Save Brick**. Kiln checks it on the
selected Relay and keeps it in your custom Bricks.

## Embers

Embers are Kiln's images for running Bricks:
`ghcr.io/kiln-site/bricks-java:11`, `:17`, `:21`, and `:25`, and
`ghcr.io/kiln-site/bricks-steamcmd:latest`. A Brick can use any other image.

The Java Ember downloads `KILN_ARTIFACT_URL` to `KILN_ARTIFACT_FILE` if it's
missing, writes `eula.txt` and a starting `server.properties` for Minecraft,
and starts Java with a heap of up to 75% of the memory limit.

| Variable               | What it does                                                                 |
| ---------------------- | ---------------------------------------------------------------------------- |
| `KILN_ARTIFACT_URL`    | Required. Where to download the server jar.                                  |
| `KILN_ARTIFACT_FILE`   | Required. The jar's file name.                                               |
| `KILN_ARTIFACT_SHA256` | The jar's SHA-256; the start stops on a mismatch.                            |
| `KILN_SERVER_KIND`     | `minecraft` (default) or `application` for anything else.                    |
| `KILN_JAVA_ARGS`       | Extra JVM flags. Heap flags are ignored; `@file` arguments stop the start.   |
| `KILN_SERVER_ARGS`     | Arguments after the jar. Defaults to `--nogui`.                              |

The SteamCMD Ember installs `KILN_STEAM_APP_ID` anonymously, updates it on
each start, and runs `KILN_STEAM_EXECUTABLE` with `KILN_SERVER_ARGS`.

## Write a Brick

Copy the closest official Brick from
[`apps/bricks/recipes`](https://github.com/kiln-site/kiln/tree/main/apps/bricks/recipes)
and change it. This one is a trimmed Paper Brick on Java 21:

```yaml title="my-paper.yml"
format: kiln.brick/v1
metadata:
  id: my-paper
  name: My Paper
  description: Paper on Java 21, for Minecraft 1.20 and 1.21.
  game: Minecraft
  author: You
variables:
  version:
    type: string
    label: Minecraft version
    description: Paper release to install.
    required: true
    default: "1.21.4"
  memory:
    type: string
    label: Container memory
    description: Total memory limit; Java uses up to 75% for its heap.
    required: true
    default: 2G
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

Host it over HTTPS, then add it by URL or in a catalog.

- **`variables`** become fields on the **Startup** tab. Each has a `type`
  (`string`, `number`, or `boolean`), `label`, `description`, and `required`,
  and may add `default`, `options`, `rules`, or `sensitive: true`. Use one
  elsewhere as `{{ variables.<name> }}`; templates are plain text.
- The variable used as `runtime.resources.memory` is replaced by the game
  server's **Memory** limit.
- **`console.stopCommands`** stop the server without triggering
  [crash recovery](/game-servers#crash-recovery).
- **`readiness.logs`** marks the server started.
- **`network.mode`** is `minecraft-backend` for Minecraft servers and proxies,
  or `direct` to publish every port as is. The Relay picks each port's public
  number unless it sets `host`. See [Ports](/networking#ports).

The Relay rejects unknown keys. Whatever a Brick asks, its container gets a
read-only root filesystem, dropped capabilities, a process limit, and its own
network, and no host folders, privileged mode, or Docker socket. The full
format is in
[`recipe-v1.md`](https://github.com/kiln-site/kiln/blob/main/apps/bricks/docs/recipe-v1.md).

## Write a catalog

```yaml title="catalog.yml"
format: kiln.catalog/v1
name: My Bricks
author: You
recipes:
  - recipes/my-paper.yml
```

Put it at a GitHub repository's root so people can add it as `owner/repo`. To
add a Brick to Kiln's own catalog, see
[Contributing a Brick](https://github.com/kiln-site/kiln/blob/main/apps/bricks/CONTRIBUTING.md).
