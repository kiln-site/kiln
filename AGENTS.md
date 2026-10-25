# Kiln agents

Kiln is a self-hosted platform for managing apps, databases, and game servers.
Favor simple operation and existing patterns.

Performance/Speed and UX is always the most important thing to keep in mind for every change you do.
Avoid unnecessary React renders and paints outside the changed component.

## Naming

Users see different names than the code uses. Keep the code names; don't
rename identifiers, routes, or wire formats to match the copy.
User-facing name, then what the code calls it:

- **Game Server**: `server` in Hearth's web UI (`/infra/servers`,
  `/server/$serverId`, the picker kind `"server"`), and `instance` in the Relay
  protocol, contracts, permissions (`instance.*`), and storage. CLI commands
  keep `server` (`kiln servers list`, `kiln server info`).
- **App**: `app`. **Database**: `database`.
- **Relay**: `relay`, the host node that runs the containers.
- **Hearth**: the web panel (`apps/web`).

- Write "game server" in user-facing copy wherever a server sits beside Apps,
  Databases, or Relays, or could be confused with a host: navigation, titles,
  pickers, filters, kind labels, activity, and empty states. Inside one game
  server's own pages, plain "server" is fine ("Server is running").
- Never call a Relay or its host a "server" in copy; say "Relay" or "node".
- "Instance" in copy means any managed resource (game server, database, app),
  as in "All instances".

<!-- intent-skills:start -->

## Skill Loading

Before editing files for a substantial task:

- Run `pnpm dlx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

## Work

- Use Vite+ (`vp`) and existing Effect patterns.
- Keep `.agents/skills/kiln-cli/SKILL.md` in sync with CLI changes.
- Follow the Testing rules below; prefer browser validation during
  development.
- Hearth, Relays, and the browser export OpenTelemetry traces, logs, and
  metrics through Effect (`packages/telemetry`), configured by `OTEL_*`
  variables. Errors are error logs with `exception.*` attributes and an
  `error.fingerprint` that groups occurrences. They go to whichever OTLP
  backend `OTEL_EXPORTER_OTLP_ENDPOINT` names; Kiln's maintainers read traces
  in Tempo and logs in Loki through Grafana.
- Name spans with `Effect.fn("Area.operation")` or `Effect.withSpan`, keep
  names stable and put IDs in attributes. Give long-lived loops and workers no
  span of their own, span each unit of work instead, and use metrics, not
  spans, for hot paths.
- Avoid patching framework/library internals unless explicitly given permission.
- Use Sonner for transient feedback and shared tooltips
- Every change the Relay makes to a game server, App, or database runs in its
  operation lanes. A new control operation declares the locks it takes in
  `apps/relay/src/operation-plans.ts`, and Relay-initiated work admits itself
  the same way, rather than adding a lock of its own. See
  [Relay operations](docs/relay-operations.md).
- The Relay drives Docker through its Engine API client
  (`apps/relay/src/docker-engine.ts`). Use the API for what the daemon does,
  run Docker's standalone binaries only for client-side work like Compose and
  builds, and never start the `docker` CLI. See
  [Adding Docker calls](docs/relay-runtime.md#adding-docker-calls).

## Testing

Tests exist to catch breakage that is expensive and hard to notice by hand.
Add or keep a test only when it protects one of:

- Security boundaries: authentication, permissions, credentials and secrets,
  path traversal, SSRF, parsing untrusted input.
- Data loss: backups, restores, file writes, migrations, deletion ordering.
- Formats other versions depend on: the Relay protocol, Docker labels, on-disk
  and backup formats, CLI config, release manifests.
- Non-trivial state machines and concurrency: power state, crash recovery,
  reconnects, races, cancellation.
- A regression you just fixed.

Don't write tests that:

- Assert copy, labels, constants, defaults, CSS classes, or one row of a
  lookup table.
- Re-test a library (Effect, zod, TanStack, React) or what the type system
  already guarantees.
- Assert SQL text, command arguments, call order, call counts, timeouts, or
  internal state. Assert the outcome a caller or user would see.
- Mock the module under test, or mock so much that the test only checks the
  mocks.

How to write them:

- Test through the module's real entry points. Don't export a helper, add an
  optional parameter, make a dependency nullable, or extract a module only so
  a test can reach it. If a pure piece deserves direct tests, give it its own
  module with real callers.
- When a test must replace an external system (network, child process, Docker,
  clock), swap the Effect service or Layer that production already uses for
  it, or fake it at that single boundary.
- Web code that touches MySQL runs against a real database with
  `apps/web/src/test/database.ts`; assert rows and results. CI runs these
  suites; locally run `pnpm dev:docker:test` against the dev stack's MySQL.
- Relay code that drives Docker uses the stateful fake in
  `apps/relay/src/test/docker.ts`; assert the resulting container state.
- Control time with Effect's `TestClock` or `vi.useFakeTimers`, never real
  sleeps. Keep tests independent of each other and of run order.
- Every server function must authenticate and every mutating CLI endpoint
  must refuse read-only links; `apps/web/src/server/auth-coverage.test.ts`
  enforces both. Intentional exceptions go in its allowlists with a reason.

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Development and pull requests

- Follow [Development](docs/development.md) for prerequisites, commands,
  worktree naming, optional OrbStack access, and cleanup.
- Before changing core components, start `pnpm dev:docker` and confirm Hearth
  loads at the printed URL. Validate user-visible changes in the browser.
  Docs-only work does not need a stack.
- Validate the changed behavior. Before pushing, run `pnpm verify`, the same
  checks as CI including real-MySQL tests, builds, and generated routes. Use
  individual verification stages or targeted tests while iterating. Follow
  [Contributing](CONTRIBUTING.md) for PR conventions. When asked to deliver a PR,
  commit, push, and open it ready for review. Never merge it yourself.
- After merge, follow the cleanup instructions in the development guide.

## References

[Pterodactyl Panel](https://github.com/pterodactyl/panel) and
[Wings](https://github.com/pterodactyl/wings) are useful operational references,
but Kiln should be a reimagining, not a clone.
