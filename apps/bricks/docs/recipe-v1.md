# `kiln.brick/v1`

The v1 recipe is a strict YAML or JSON document. Unknown keys are rejected.
This prevents a misspelling from silently producing a less secure container.

## Contract

- `format` is exactly `kiln.brick/v1`. Semantics never change within a format.
- `metadata` identifies and describes the package. IDs are labels, not a Relay
  allowlist.
- `variables` defines the per-deployment form. A variable has a scalar type,
  optional default/options, validation rules, and a `sensitive` display hint.
- `runtime` selects any OCI image and maps resolved values to its environment,
  process, storage, and resource configuration.
- `console.stopCommands` optionally lists exact commands that intentionally stop
  the server when a user sends them through Hearth's console. Relay uses this
  only to suppress automatic crash recovery for that panel action; it does not
  interpret container signals, external console clients, or server log lines.
- `readiness.logs` optionally lists literal log fragments that indicate the
  server has completed startup. Relay searches the current container session
  for these fragments before marking the server running; Docker health checks
  take precedence when present.
- `network` declares ports and one of two stable Relay routing modes.
- `constraints` can limit CPU architectures.

The normative schema is [`schema/recipe-v1.schema.json`](../schema/recipe-v1.schema.json).

## Icons and colors

`metadata.icon` may link to an SVG over HTTPS or use a path relative to the
recipe. Kiln snapshots valid icons with catalogs and custom recipes. Icon
failures never make the Brick unavailable; Kiln shows a generic box and retries
with backoff. `metadata.color` is an optional `#rrggbb` color. An icon without a
color receives a deterministic color derived from the Brick id, while a color
without an icon colors the generic fallback.

Icons should follow the same compact mark style as Simple Icons: a transparent,
square canvas with one foreground color and no embedded text or background.
Kiln renders SVGs as masks, so gradients and source colors are intentionally
reduced to the configured single color. SVGs must be at most 64 KiB, declare a
square `viewBox`, and contain no scripts, event handlers, external resources,
animation, or embedded HTML.

```yaml
metadata:
  icon: ../icons/example.svg
  color: "#4b98b0"
```

`runtime.resources.memory` is the exact Docker hard limit. The optional
`memoryReservation` is the soft reservation and defaults to the hard limit.
Runtime-specific overhead must fit inside that limit; Relay does not silently
increase it. The official Java Ember uses a container-aware heap percentage so
native JVM memory remains within the declared allocation. Extra JVM flags belong
in a `java_args` variable mapped to `KILN_JAVA_ARGS`; the Ember always supplies
`-Xms` and either `-XX:MaxRAMPercentage` or `-Xmx`. Heap aliases such as
`-XX:MaxHeapSize` and `-XX:MaxRAMPercentage` are rejected by official recipes
and ignored by the Ember. Disabling container-aware heap sizing (`-XX:-UseContainerSupport`) is rejected
the same way so `MaxRAMPercentage` stays bound to the container limit. Java
argument files (`@flags.txt`, `-XX:VMOptionsFile`) are rejected so they cannot
inject heap flags after Ember validation. Quoted values such as
`-Dmessage="hello world"` stay a single argument. Minecraft server Bricks also
get `--nogui` from `KILN_SERVER_ARGS` unless the recipe clears that variable.

## Templates

The following string templates are supported:

```text
{{ variables.<name> }}
{{ brick.id }}
{{ brick.name }}
```

Relay performs literal interpolation. Templates are not a shell and cannot run
expressions or commands. Every referenced variable must be declared and have a
resolved value.

## Networking modes

- `minecraft-backend` applies Minecraft-aware readiness and SRV behavior.
- `direct` publishes every declared port for games that expose themselves
  directly.

The named `primaryPort` must match one entry in `ports`. Relay generates an
available host port unless a recipe explicitly declares `host`; fixed host port
conflicts are reported by Docker.

## Security boundary

Recipes are executable infrastructure: an image, entrypoint, command, and
environment determine what runs. Only deploy recipes you trust. Relay still
enforces its own storage root, read-only root filesystem, dropped capabilities,
`no-new-privileges`, PID limit, and isolated network; recipes cannot request
host paths, capabilities, privileged mode, or the Docker socket.

Custom recipe sources must use HTTPS. A Relay operator may explicitly configure
a local `file:` catalog for development or air-gapped installations.

## Compatibility

Relay dispatches on `format`. It should retain a decoder/executor for every safe
older format. A format may be disabled only when continuing to execute it would
be unsafe or when an explicitly documented migration is unavoidable.
