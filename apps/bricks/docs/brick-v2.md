# `kiln.brick/v2` (preview)

A Brick is one JSON document that tells Kiln how to run something: a game
server, an app, or a database. It says three things:

1. **What it is**: an id, a name, and a `kind`.
2. **What it asks for**: `inputs`, which become the install form.
3. **How it runs**: `deploy`, one of four ways.

Databases add one more block, for how apps connect and how backups work.
Nothing in a Brick turns on behaviour for one kind or one game: readiness,
addresses, and SRV records work the same for every Brick. Everything else,
like memory limits, domains, and environment added later, stays a setting in
Hearth; a Brick only suggests defaults.

v2 is a preview. Relays run `kiln.brick/v1` (see [recipe-v1.md](recipe-v1.md))
until they learn v2; the official v2 Bricks in `bricks/` sit beside the v1
recipes in `recipes/` until then.

The schema is defined once, in
[`packages/contracts/src/brick-v2.ts`](../../../packages/contracts/src/brick-v2.ts).
kiln.site serves it as JSON Schema at <https://kiln.site/bricks/schema.json>,
and its [creator](https://kiln.site/bricks/new) checks Bricks against the same
definition.

## Why JSON

People build and read Bricks in the creator, so the file is for programs:
JSON needs no extra parser in the Relay, has one way to write each value, and
gets completion in any editor that reads `$schema`.

## An example

```json
{
  "$schema": "https://kiln.site/bricks/schema.json",
  "format": "kiln.brick/v2",
  "id": "paper",
  "name": "Paper",
  "kind": "game-server",
  "game": "Minecraft",
  "summary": "Fast, plugin-compatible Minecraft server for most projects.",
  "author": "Kiln",
  "inputs": [
    {
      "key": "version",
      "label": "Minecraft version",
      "type": "text",
      "default": "26.2"
    },
    {
      "key": "java_version",
      "label": "Java version",
      "type": "select",
      "options": ["17", "21", "25"],
      "default": "21",
      "suggest": [{ "when": "version", "matches": "^26\\.", "value": "25" }]
    }
  ],
  "deploy": {
    "type": "image",
    "image": "ghcr.io/kiln-site/bricks-java:{{ java_version }}",
    "env": { "KILN_VERSION": "{{ version }}" },
    "ports": [{ "name": "game", "port": 25565 }],
    "volumes": ["/server"],
    "ready": { "log": [")! For help, type "] },
    "memory": "2G",
    "stop": ["stop"]
  }
}
```

## Rules of the format

- Unknown fields are errors, so a typo can't quietly change a deployment.
- Fields are optional unless Kiln can't run the Brick without them. Where an
  optional field has a default, the default is written below and isn't added
  to the file.
- Kinds and ways to deploy are independent: a game server can be a Compose
  project, and a database can be built from a Dockerfile. Only apps can be
  static sites.
- Parsing never changes a Brick, so the creator round-trips it unchanged.

## Top level

| Field       |              |                                                                                   |
| ----------- | ------------ | --------------------------------------------------------------------------------- |
| `format`    | required     | `kiln.brick/v2`                                                                   |
| `id`        | required     | Lowercase letters, numbers, and dashes. Unique in its catalog.                    |
| `name`      | required     |                                                                                   |
| `kind`      | required     | `game-server`, `app`, or `database`. Decides where it shows in Hearth.            |
| `game`      | game servers | The game it runs, like `Minecraft`. Groups servers and names their SRV record.    |
| `summary`   | required     | One line for the catalog.                                                         |
| `author`    | required     | Who made it.                                                                      |
| `icon`      |              | A square, single-colour SVG: a path relative to the Brick, or an `https://` link. |
| `color`     |              | `#rrggbb`. Hearth picks one from the id without it.                               |
| `tags`      |              | For search.                                                                       |
| `links`     |              | `homepage`, `source`, `docs`, `support`, each `https://`. Shown with the author.  |
| `platforms` |              | `amd64`, `arm64`. Any, without it.                                                |
| `inputs`    |              | The install form, in order.                                                       |
| `deploy`    | required     | How it runs.                                                                      |
| `database`  | databases    | How apps connect, and how it's backed up.                                         |

Official icons live in [`icons/`](../icons) and can be linked from any Brick
as `https://raw.githubusercontent.com/kiln-site/kiln/main/apps/bricks/icons/<name>.svg`.

## Inputs

Each input is one field of the install form. Its answer is available to
templates as `{{ key }}`.

| Field         |          |                                                              |
| ------------- | -------- | ------------------------------------------------------------ |
| `key`         | required | `snake_case`.                                                |
| `label`       | required |                                                              |
| `type`        | required | `text`, `number`, `boolean`, `select`, or `secret`.          |
| `help`        |          | A line under the field.                                      |
| `placeholder` |          |                                                              |
| `default`     |          | Of the input's type; for `select`, one of its options.       |
| `optional`    |          | Inputs are required unless this is `true`.                   |
| `advanced`    |          | Folds it under "Advanced".                                   |
| `options`     | `select` | Values, or `{ "value", "label" }`.                           |
| `pattern`     |          | A regular expression a `text` or `secret` answer must match. |
| `min`, `max`  |          | A number's bounds, or a text's length.                       |
| `generate`    |          | `secret` only: Kiln makes a strong random value at install.  |
| `suggest`     |          | Defaults that follow another answer.                         |

`suggest` replaces logic the Relay used to hard-code, like picking Java from
the Minecraft version. Each rule is `{ "when": "<input>", "matches":
"<regex>", "value": ... }`; the first rule whose input matches gives the
default, and `default` applies when none do. Someone installing it can still
change the value.

## Templates

Strings in `deploy` and `database` can use `{{ name }}`, where the name is an
input's key or one of:

|              |                                          |
| ------------ | ---------------------------------------- |
| `kiln.brick` | The Brick's id                           |
| `kiln.name`  | The name the instance was given          |
| `kiln.host`  | The hostname other instances reach it by |

Templates are literal replacement: no expressions, escaping, or shell. A
template naming anything else is an error.

## Deploy

`deploy.type` is one of:

| Type         | Runs                                                                      | Asks for a source |
| ------------ | ------------------------------------------------------------------------- | ----------------- |
| `image`      | `image`, a Docker image                                                   | No                |
| `dockerfile` | A build of `dockerfile` (written in the Brick) or of `path` in the source | Only with `path`  |
| `compose`    | `compose` (written in the Brick) or the file at `path` in the source      | Only with `path`  |
| `static`     | Files from the source, served by the Relay's shared web server            | Always            |

A source is a Git repository, built on every push, or an upload. It's chosen
at install, not written in the Brick, so one Brick serves every repository
with a Dockerfile.

Every type but `static` takes:

| Field      |                                                                                        |
| ---------- | -------------------------------------------------------------------------------------- |
| `env`      | Environment variables. Values take templates. For Compose, the project's `.env`.       |
| `ports`    | What it listens on. The first is the one Hearth shows.                                 |
| `ready`    | When it counts as started (below).                                                     |
| `memory`   | A starting memory limit, like `512M` or `2G`. Hearth's own limit wins.                 |
| `hostname` | The name it gets under the Relay's domain. Takes templates. Kiln names it without one. |
| `stop`     | Console commands that stop it on purpose, so Kiln doesn't restart it.                  |

`image` and `dockerfile` also take:

| Field     |                                                                                           |
| --------- | ----------------------------------------------------------------------------------------- |
| `command` | Replaces the image's command, one argument per entry.                                     |
| `user`    | A numeric `user:group` to run as.                                                         |
| `volumes` | Absolute paths kept across restarts. The first is the one Files opens.                    |
| `files`   | `{ "path", "content", "once" }` written before it starts; with `once`, only when missing. |

`compose` also takes `service`, the one whose console and logs Hearth opens
first; ports name their `service` too. The Compose file declares everything
else.

`static` takes `root`, the folder to serve; `build`, an `image` and `command`
run once per deploy (skipped when the command is empty); and `spa`, which
answers unknown paths with `index.html`. Static sites share one web server
per Relay, so they have no container or limits of their own.

### Ports

`{ "name", "port", "protocol", "expose", "service" }`. `protocol` is `tcp`
(default), `udp`, or `both`. `expose` is how it's reached:

|           |                                                              |
| --------- | ------------------------------------------------------------ |
| `public`  | A port on the Relay. Default for game servers.               |
| `http`    | An HTTPS domain through the Relay's proxy. Default for apps. |
| `private` | Only from instances connected to it. Default for databases.  |

Kiln always picks the host port. Game servers get an SRV record for their
first port, so players join with a name and no port.

### Ready

|                                  |                                                |
| -------------------------------- | ---------------------------------------------- |
| `{ "log": [...] }`               | The log shows any of these lines.              |
| `{ "command": "..." }`           | The command succeeds in the container.         |
| `{ "http": "/", "port": "web" }` | A GET answers, on the named port or the first. |

Without `ready`, it's ready once its first port answers.

## Database

| Field        |          |                                                                                           |
| ------------ | -------- | ----------------------------------------------------------------------------------------- |
| `port`       | required | The port clients connect to, by name.                                                     |
| `connection` | required | The URL Hearth hands to apps that connect. Takes templates.                               |
| `viewer`     |          | `mysql` or `postgres`: one of Hearth's viewers. Hearth opens it for official Bricks only. |
| `backup`     |          | A command that writes a dump to stdout. Without it, backups snapshot the volume.          |
| `restore`    |          | A command that reads a dump from stdin. Needs `backup`.                                   |

## Catalogs

A catalog lists Bricks at a URL:

```json
{
  "format": "kiln.catalog/v2",
  "name": "Kiln",
  "author": "QarthO",
  "bricks": ["bricks/paper.json"]
}
```

Entries are paths relative to the catalog or `https://` links. The official
catalog is [`catalog.json`](../catalog.json); reviewed community Bricks live
in [`community/`](../community/README.md).

## From v1

| v1                                                                       | v2                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `metadata.*`                                                             | Top level; `metadata.game` is `game`.                             |
| `variables` (a map)                                                      | `inputs` (a list, so the form keeps its order).                   |
| `required: true`                                                         | The default; `optional: true` otherwise.                          |
| `rules.{pattern,min,max,minLength,maxLength}`                            | `pattern`, `min`, `max`.                                          |
| `{{ variables.x }}`, `{{ brick.id }}`                                    | `{{ x }}`, `{{ kiln.brick }}`                                     |
| `runtime`                                                                | `deploy` with `type: "image"`; `environment` is `env`.            |
| `runtime.storage.mount`                                                  | The first of `deploy.volumes`.                                    |
| A `memory` variable mapped to `runtime.resources.memory`                 | `deploy.memory`, a default for Hearth's own limit.                |
| `runtime.resources.pids`, `entrypoint`, `workingDirectory`, `stopSignal` | Dropped: Kiln's defaults cover every official Brick.              |
| `network.ports` and `primaryPort`                                        | `deploy.ports`; the first is primary. No fixed host ports.        |
| `network.mode` (`minecraft-backend`, `direct`)                           | Dropped: readiness and SRV records work the same for every Brick. |
| `network.hostname`                                                       | `deploy.hostname`                                                 |
| `readiness.logs`                                                         | `deploy.ready.log`                                                |
| `console.stopCommands`                                                   | `deploy.stop`                                                     |
| `constraints.architectures`                                              | `platforms`                                                       |
| Java chosen by the Relay from the version                                | `suggest` rules on the Java input.                                |
