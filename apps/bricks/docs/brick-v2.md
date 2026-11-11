# `kiln.brick/v2`

A Brick is a YAML document that tells Kiln how to run something: a game
server, a database, an App, or a group of them. It is one of three separate
things:

- **The Brick** is the recipe. It lives in a catalog, or in a repository.
- **The source** is where a Brick's files come from: nothing (an image), a
  Git repository, or an upload. It is chosen at install and is never written
  in the recipe, so one Dockerfile Brick serves every repository.
- **The Kiln file** is a Brick with settings, kept in a repository. It isn't
  built yet; `settings` is reserved for it (see [Settings](#settings)).

The format is defined once, in
[`packages/contracts/src/brick-recipe.ts`](../../../packages/contracts/src/brick-recipe.ts).
[`schema/brick-v2.schema.json`](../schema/brick-v2.schema.json) is generated
from it for editors. The official Bricks are in [`bricks/`](../bricks), listed
by [`bricks.yml`](../bricks.yml).

## What Kiln runs today

The format describes every kind. Kiln reads them in stages.

| Part                             | Status                                |
| -------------------------------- | ------------------------------------- |
| Game server Bricks from an image | Run                                   |
| `type: minecraft`                | Run                                   |
| Database Bricks of a known type  | Run from Kiln's own catalog, on that type's image |
| A database's `connection`        | Defined here; Kiln builds a type's URL itself |
| A database Brick with no type    | Defined here; not installable yet     |
| App and group Bricks             | Defined here; not installable yet     |
| `dockerfile` and `compose`       | Defined here; Apps use them later     |
| `ready` by command               | Run for databases; game servers use logs |
| `ready` by HTTP                  | Defined here; Apps use it later       |
| Ports that aren't `public`       | Defined here; not for game servers    |
| A raster icon                    | Defined here; SVG marks are shown     |
| `settings`                       | Reserved; refused until it is defined |

A Relay refuses a Brick that uses a part it doesn't run yet, and says which.
Those parts are provisional (see the rules below).

## Rules of the format

- Unknown fields are errors, so a typo can't quietly change a deployment.
- Reading a Brick never changes it: no field is filled in with a default.
  Where a field has one, it is written below.
- A template that names nothing is an error.
- Semantics never change within a format once Kiln runs them. What Kiln
  doesn't run yet is provisional: an App, a group, a database with no type,
  and the parts only they use may still change, until the first
  implementation of each proves it. Game server Bricks and typed database
  Bricks are settled, except a database's `connection`, which nothing reads
  yet.

## An example

```yaml
format: kiln.brick/v2
kind: game-server
type: minecraft
metadata:
  id: paper
  name: Paper
  summary: Fast, plugin-compatible Minecraft server for most projects.
  author: Kiln
  icon: ../icons/paper.svg
inputs:
  - key: version
    label: Minecraft version
    type: text
    default: "26.2"
  - key: java_version
    label: Java version
    type: select
    options: ["17", "21", "25"]
    default: "21"
    suggest:
      - { when: version, from: "26.1", value: "25" }
deploy:
  type: image
  image: "ghcr.io/kiln-site/bricks-java:{{ java_version }}"
  env: { KILN_VERSION: "{{ version }}" }
  memory: 2G
  volumes: [/server]
  ports:
    - { name: game, port: 25565 }
  ready:
    log: [")! For help, type "]
game-server:
  game: Minecraft
  stop: [stop]
```

## Top level

| Field         |               |                                                        |
| ------------- | ------------- | ------------------------------------------------------ |
| `format`      | required      | `kiln.brick/v2`                                        |
| `kind`        | required      | `game-server`, `database`, `app` or `group`            |
| `type`        |               | Within a kind; see [Kinds and types](#kinds-and-types) |
| `metadata`    | required      | Who it is                                              |
| `inputs`      |               | The install form, in order                             |
| `deploy`      | all but group | How it runs                                            |
| `game-server` | game servers  | What only a game server has                            |
| `database`    | databases     | What only a database has                               |
| `minecraft`   | by type       | Which of the type's extras it uses                     |
| `group`       | groups        | Its members                                            |

## Metadata

| Field       |          |                                                                     |
| ----------- | -------- | ------------------------------------------------------------------- |
| `id`        | required | Lowercase letters, numbers, dots and dashes. Unique in its catalog. |
| `name`      | required |                                                                     |
| `revision`  |          | A whole number, 1 without it. See below.                            |
| `summary`   | required | One line for the catalog.                                           |
| `author`    | required |                                                                     |
| `icon`      |          | A path beside the recipe, or an `https://` link.                    |
| `color`     |          | `#rrggbb`. Kiln derives one from the ID without it.                 |
| `tags`      |          | For search.                                                         |
| `links`     |          | `homepage`, `source`, `docs`, `support`.                            |
| `platforms` |          | `amd64`, `arm64`. Any, without it.                                  |

`revision` says which version of the recipe this is. Its author raises it
when a change is one that instances already installed from the Brick should
be offered: a new image, a variable, a changed port. A change that only
matters to new installs, such as a summary or an icon, leaves it alone. It
isn't the version of what the Brick runs, which is usually an input.

An SVG icon is a single-colour mark: a transparent, square canvas with one
foreground colour and no text, rendered as a mask in `color`. It must be at
most 64 KiB, declare a square `viewBox`, and contain no scripts, event
handlers, external resources, animation or embedded HTML. A PNG, WebP or
JPEG icon is a full image, shown as it is. An icon that can't be read never
makes a Brick unavailable; Kiln shows a generic one.

## Inputs

Each input is one field of the install form. Its answer is available to
templates as `{{ key }}`. A recipe may have as many as it needs.

| Field       |          |                                                                             |
| ----------- | -------- | --------------------------------------------------------------------------- |
| `key`       | required | `snake_case`.                                                               |
| `label`     | required |                                                                             |
| `type`      | required | `text`, `number`, `boolean`, `select` or `secret`.                          |
| `help`      |          | A line under the field.                                                     |
| `default`   |          | Of the input's type; for a select, one of its options.                      |
| `optional`  |          | Inputs are required unless this is `true`.                                  |
| `advanced`  |          | Folds it under Advanced.                                                    |
| `options`   | `select` | The values to choose from, all of one type.                                 |
| `pattern`   |          | A regular expression an answer that is text must match.                     |
| `min`       |          | A number's lower bound, or a text's shortest length.                        |
| `max`       |          | A number's upper bound, or a text's longest length.                         |
| `sensitive` |          | Keeps what it holds out of what Kiln shows of a recipe. A secret always is. |
| `generate`  | `secret` | Kiln makes a strong random value when none is given.                        |
| `suggest`   |          | Defaults that follow another answer.                                        |

### Sensitive inputs

A `secret`, and any input marked `sensitive`, holds something that shouldn't
be shown. Its default, its options and the values its rules suggest are left
out wherever Kiln shows the recipe, and its answer is left out of error
messages. A text or number answer is masked in the form.

A select or a boolean is answered by choosing from what the form shows, so
its choices are visible to whoever is installing the Brick. Mark one
sensitive to keep it out of previews, not to hide it from that person.

### Suggest

A `suggest` rule makes an input's default follow another input's answer. It
replaces logic that used to be written into Kiln, such as which Java a
Minecraft version needs.

```yaml
suggest:
  - { when: version, from: "26.1", below: "27", value: "25" }
  - { when: version, from: "1.20", below: "1.22", value: "21" }
  - { when: version, matches: "^legacy-", value: "11" }
```

`when` names the other input, which can't be a secret Kiln generates: that
is made at install, after every answer is worked out. `from` and `below` compare its answer as a
version, by number (`1.9` is older than `1.17`), ignoring anything after the
numbers such as `-SNAPSHOT`. `matches` is a regular expression. A rule with
several conditions needs all of them.

An input's answer is worked out in this order:

1. What someone answered, as it is.
2. Otherwise the value of its first rule that applies.
3. Otherwise its `default`.
4. Otherwise nothing, which a required input refuses.

Inputs can follow each other in any order of the form, and through one
another: a tag can follow a channel and an image follow the tag. They can't
follow each other in a circle. When an
answer changes in Hearth, everything that follows it is worked out again,
which replaces a value chosen there earlier. Someone can then choose another
value, and it stands.

A value a rule asks for that the input doesn't allow is refused, with what
asked for it, in Hearth before the form is sent and again by the Relay. It
is never swapped for the default: a Minecraft release that needs a Java this
Brick doesn't offer fails at install, not after it starts.

## Templates

A deployment's `image`, `runtime`, `env` and `memory`, the `database`
section, and a group member's `connect` can use `{{ name }}`:

|                                                 |                                        |
| ----------------------------------------------- | -------------------------------------- |
| `{{ <input key> }}`                             | An answer                              |
| `{{ brick.id }}`, `{{ brick.name }}`            | The Brick's own                        |
| `{{ database.name }}`, `.username`, `.password` | A database Brick: the login Kiln makes |
| `{{ database.host }}`, `{{ database.port }}`    | A database Brick: where it is reached  |
| `{{ connection }}`, `host`, `port`, `name`, …   | In `connect`: the member connected to  |

Templates are literal replacement: no expressions, escaping or shell. A
command, an entrypoint, and a Dockerfile or Compose file written in the Brick
are passed on as they are.

## Deploy

`deploy.type` is one of:

| Type         | Runs                                                                      | Needs a source   |
| ------------ | ------------------------------------------------------------------------- | ---------------- |
| `image`      | `image`, a Docker image                                                   | No               |
| `dockerfile` | A build of `dockerfile` (written in the Brick) or of `path` in the source | Only with `path` |
| `compose`    | `compose` (written in the Brick) or the file at `path` in the source      | Only with `path` |

Every type takes:

| Field    |                                                                        |
| -------- | ---------------------------------------------------------------------- |
| `env`    | Environment variables. Values take templates.                          |
| `ports`  | What it listens on. The first is the one Hearth shows.                 |
| `ready`  | When it counts as started.                                             |
| `memory` | A starting memory limit, like `512M` or `2G`. Hearth's own limit wins. |

`image` and `dockerfile` also take:

| Field              |                                                               |
| ------------------ | ------------------------------------------------------------- |
| `volumes`          | Paths kept across restarts. The first is the one Files opens. |
| `runtime`          | What it runs on, shown beside the instance, like `Java 21`.   |
| `user`             | A numeric `user` or `user:group` to run as.                   |
| `command`          | Replaces the image's command, one argument per entry.         |
| `entrypoint`       | Replaces the image's entrypoint.                              |
| `workingDirectory` | An absolute path.                                             |
| `stopSignal`       | Like `SIGINT`.                                                |
| `pids`             | How many processes it may run. 512 without it.                |

`compose` also takes `service`, the one whose console and logs open first;
its ports name their `service` too.

`memory` must fit everything the container runs. The official Java Ember
sizes its heap as a share of the container's limit, so extra JVM flags go in
a `java_args` input mapped to `KILN_JAVA_ARGS`, and the official Bricks refuse
flags that would set the heap or the start command themselves.

### Ports

`{ name, port, protocol, expose, host, service }`. `protocol` is `tcp`
(default), `udp` or `both`. `port` is a number, or one number input's answer
as `{{ key }}`. `expose` is how it is reached:

|           |                                                              |
| --------- | ------------------------------------------------------------ |
| `public`  | A port on the Relay. Default for game servers.               |
| `http`    | An HTTPS domain through the Relay's proxy. Default for Apps. |
| `private` | Only from instances connected to it. Default for databases.  |

Kiln picks the port on the Relay unless a public port names a fixed `host`;
a fixed port already in use is reported by Docker.

### Ready

|                            |                                                |
| -------------------------- | ---------------------------------------------- |
| `{ log: [...] }`           | The log shows any of these lines.              |
| `{ command: "..." }`       | The command succeeds in the container.         |
| `{ http: "/", port: web }` | A GET answers, on the named port or the first. |

A `log` line decides by itself: nothing else is checked once one is given.
Without `ready`, it is ready once its first port answers a TCP connection,
or for the `minecraft` type a status ping. A port that is UDP only can't be
asked, so a Brick with one needs a `log` line. A Docker health check in the
image takes precedence.

## Kinds and types

A kind decides which foundation an instance gets and which section a Brick
has. A type, within a kind, unlocks extras Kiln implements in code. A Brick
with no type runs with the foundation and nothing more.

| Kind          | Its section                                  | Types               |
| ------------- | -------------------------------------------- | ------------------- |
| `game-server` | `game-server`: `game`, `stop`, `srv`         | `minecraft`         |
| `database`    | `database`: `connection`, `export`, `import` | See below           |
| `app`         | None                                         | None                |
| `group`       | `group`: `members`                           | None                |

### Game servers

| Field  |                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `game` | The game it runs, which groups servers. The Brick's name, without one.                                                          |
| `stop` | Console commands that stop it on purpose. Kiln uses them only to tell a requested stop from a crash, so it isn't started again. |
| `srv`  | Whether players can join by name through an SRV record.                                                                         |

`type: minecraft` puts the server behind the Relay's Minecraft entry point,
which publishes only its first port and gives it an SRV record. Without a
`ready` line, readiness is a Minecraft status ping. Its section says which extras the Brick uses:

| Field           |                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `latestVersion` | `velocity`: with no `version` answered at install, Kiln installs Velocity's newest release.                                 |
| `completion`    | `true` when its console completes a command it is asked about, as Paper's does. Kiln then offers completion in the console. |

### Databases

| Field        |          |                                                             |
| ------------ | -------- | ----------------------------------------------------------- |
| `connection` | required | The URL handed to whatever connects to it. Takes templates. |
| `export`     |          | A command that writes a dump to stdout.                     |
| `import`     |          | A command that reads a dump from stdin.                     |

A database's name, login, host and port are Kiln's to give, not answers:
its templates take them as `database.name`, `database.username`,
`database.password`, `database.host` and `database.port`, in `deploy.env`
and in `connection`.

A database listens on its first port, keeps its data in its first volume,
and is ready when its `ready` command succeeds.

| Type                           | What Kiln adds                                              |
| ------------------------------ | ----------------------------------------------------------- |
| `postgres`, `mysql`, `mariadb` | The table viewer, dumps and restores, and password rotation |
| `redis`, `valkey`              | Its login, as an ACL file in the data volume, and rotation  |

Kiln does those through the type's own image: its command-line tools,
which reach the engine on its usual port, and the variables it takes its
first login from. So a database of a type runs from that type's image and
no other, at whatever tag, and listens on that port:

| Type       | Image           | Port |
| ---------- | --------------- | ---- |
| `postgres` | `postgres`      | 5432 |
| `mysql`    | `mysql`         | 3306 |
| `mariadb`  | `mariadb`       | 3306 |
| `redis`    | `redis`         | 6379 |
| `valkey`   | `valkey/valkey` | 6379 |

Its environment sets the variables that image takes its first login from,
each to what Kiln supplies, because Kiln's dumps, restores and wipes read
them back inside the container:

| Type       | Variables                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------- |
| `postgres` | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`                                           |
| `mysql`    | `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_ROOT_PASSWORD` as a made secret  |
| `mariadb`  | `MARIADB_DATABASE`, `MARIADB_USER`, `MARIADB_PASSWORD`, and `MARIADB_ROOT_PASSWORD` likewise  |

The name, user and password are `{{ database.name }}`,
`{{ database.username }}` and `{{ database.password }}`; a root password is
a `secret` input with `generate: true` and no `default` or `suggest`, so
that it is always one Kiln made.

Redis and Valkey keep their data in `/data` and start with
`--aclfile /data/users.acl`, the users file Kiln writes their login to.

A typed database's connection URL is the one Kiln builds for its type;
`connection` is for a database with no type, and isn't read yet.

A type brings its own export and import. `export` and `import` are for a
database with no type, which has neither a viewer nor files; without
`export`, its backups copy the volume.

### Groups

A group makes several instances and keeps them together. It runs nothing
itself. Each member is another Brick, by its ID in the same catalog or by an
`https://` link, or a recipe written in place:

```yaml
format: kiln.brick/v2
kind: group
metadata:
  id: umami
  name: Umami
  summary: Privacy-focused web analytics.
  author: Kiln
inputs:
  - { key: secret, label: App secret, type: secret, generate: true }
group:
  members:
    database:
      brick: postgres
    web:
      kind: app
      deploy:
        type: image
        image: ghcr.io/umami-software/umami:postgresql-latest
        env: { APP_SECRET: "{{ secret }}" }
        ports: [{ name: web, port: 3000 }]
      connect:
        database: { DATABASE_URL: "{{ connection }}" }
```

- A member that names a Brick is pinned to the copy installed, as every
  instance pins its recipe. It can give `inputs`, answers for that Brick's
  form.
- A member written in place uses the group's inputs and has none of its own.
- `connect` names another member and the environment variables this one gets
  for reaching it.

A database inside a Compose project is only a container. As a group member it
is a database of its own, with the viewer, dumps, backups and permissions a
database has.

## Settings

`settings` is reserved for what Hearth holds for an instance: volumes,
domains, limits, backups and schedules. It is what will make a recipe in a
catalog and a Kiln file in a repository one format. Nothing defines it yet,
so a Brick that has it is refused like any other unknown field.

## Catalogs

A catalog lists Bricks at a URL:

```yaml
format: kiln.catalog/v1
name: Kiln
author: QarthO
recipes:
  - bricks/paper.yml
```

Entries are paths relative to the catalog, or `https://` links.

## Security boundary

A Brick is executable infrastructure: its image, command and environment
decide what runs. Only install Bricks you trust. The Relay still enforces its
own storage root, read-only root filesystem, dropped capabilities,
`no-new-privileges`, a process limit and an isolated network; a Brick can't
ask for host paths, capabilities, privileged mode or the Docker socket.

Custom Brick sources must use HTTPS. A Relay operator may configure a local
`file:` catalog for development or air-gapped installations.

## From v1

`kiln.brick/v1` ([recipe-v1.md](recipe-v1.md)) described game servers only.
Kiln converts a v1 recipe wherever it reads one: a catalog or a link that
still serves v1, the copy a Relay keeps for each server, the Bricks and
catalogs Hearth stored, and the recipe inside a backup. New Bricks are
written in v2.

A server keeps the recipe it was made from, named by a checksum of the file
on its Relay. That file is never rewritten, so a server made from a v1 recipe
keeps a v1 file, read as v2 each time, until its Brick is changed or
reinstalled.

| v1                                               | v2                                                             |
| ------------------------------------------------ | -------------------------------------------------------------- |
| No kind                                          | `kind: game-server`                                            |
| `metadata.description`                           | `metadata.summary`                                             |
| `metadata.game`                                  | `game-server.game`                                             |
| `metadata.documentation`                         | `metadata.links.docs`                                          |
| `constraints.architectures`                      | `metadata.platforms`                                           |
| `variables` (a map)                              | `inputs` (a list, so the form keeps its order)                 |
| `required: true`                                 | The default; `optional: true` otherwise                        |
| `description`                                    | `help`                                                         |
| `type: string`                                   | `text`; `select` with `options`                                |
| `sensitive`                                      | `secret` for text; `sensitive: true` on any other input        |
| `rules.{pattern,min,max,minLength,maxLength}`    | `pattern`, `min`, `max`                                        |
| `{{ variables.x }}`                              | `{{ x }}`                                                      |
| `runtime`                                        | `deploy` with `type: image`                                    |
| `runtime.name`                                   | `deploy.runtime`                                               |
| `runtime.environment`                            | `deploy.env`                                                   |
| `runtime.storage.mount`                          | The first of `deploy.volumes`                                  |
| `runtime.resources.memory`                       | `deploy.memory`                                                |
| `runtime.resources.pids`                         | `deploy.pids`                                                  |
| `runtime.resources.memoryReservation`            | Dropped: it never set anything                                 |
| `network.ports` and `primaryPort`                | `deploy.ports`; the primary port is first                      |
| `ports[].container`                              | `ports[].port`                                                 |
| `network.mode: minecraft-backend`                | `type: minecraft`                                              |
| `network.mode: direct`                           | No type                                                        |
| `network.supportsSrv`                            | `game-server.srv`                                              |
| `network.hostname`                               | Dropped: nothing read it                                       |
| `readiness.logs`                                 | `deploy.ready.log`                                             |
| `console.stopCommands`                           | `game-server.stop`                                             |
| A `memory` variable mapped to the memory limit   | Kept when converted; new Bricks write `deploy.memory` directly |
| Java chosen from the Minecraft version, in Kiln  | `suggest` rules on the Java input                              |
| Velocity's newest version, looked up by Brick ID | `minecraft.latestVersion: velocity`                            |
