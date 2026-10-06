# Kiln agents

Kiln is a fast, approachable, reliable self-hosted server platform panel/orchestrator. It's catered towards game servers (focus on Minecraft), but should be agnostic to other servers.
Favor simple operation and existing patterns over new abstractions,

Performance/Speed and UX is always the most important thing to keep in mind for every change you do. Make sure any UI change doesn't cause react to re-render/paint other components. If needed react-scan and react-audit can be used to verify.

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
- This project uses Sentry.io for errors, traces, session replays, and more. Review the
  `sentry-cli` skill when debugging.
- Avoid patching framework/library internals unless explicitly given permission.
- Use Sonner for transient feedback and shared tooltips
- For user-visible or runtime work, use T3 Code's collaborative Preview against
  the OrbStack URL printed by `pnpm dev:docker`; never use a local IP for
  development or validation.

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

## Setup

Run once per clone from `main`:

```sh
vp install --frozen-lockfile
pnpm dev:setup
```

# Pull Requests

These are just suggestions, don't treat these as law.

## PR Branches

Name branches as `<type>/<task>`, with a short lowercase kebab-case task:

Examples:

| Prefix  | Use for                        |
| ------- | ------------------------------ |
| `feat/` | New capabilities               |
| `fix/`  | Bugs and regressions           |
| `ui/`   | Visual and interaction changes |
| `ci/`   | CI and release automation      |

For example: `fix/panel-disconnect`. Do not use personal or agent-name
prefixes.

## PR Title

Use `<type>(<scope>): <short human title>`.
Examples:

- fix(relay): prevent player disconnects when updating relays
- ci(repo): update agent skills
- ui(cli): improve help menu visual

## PR Description

Keep PR descriptions minimal and human:

```md
# Why

What it fixes or implements. Link an issue when one exists.

# Summary

Brief summary.

# Notes

Breaking changes, compatibility notes, migration steps, or anything else reviewers need to know.
```

Do not update the description during review for follow-up commits or fixes unless the overall PR changes.

# Implementing a change

Before making a change to any of Kiln's core components, you'll need to set up the preview/testing environment:

1. In the new worktree, run `pnpm dev:docker`.
2. Immediately open the printed OrbStack URL in T3 Preview, leave it available
   for the user, and confirm Hearth loads before making any changes.
3. Develop and validate using that T3 Preview.
4. Commit, push, and open a ready-for-review PR. Never merge the PR yourself.

# After PR Merge Cleanup

1. Run `pnpm dev:docker:destroy` in the merged worktree.
2. Switch to `main` and run `git pull --ff-only`.
3. Delete the merged worktree and local branch.
4. Delete the merged branch from `origin` with `git push origin --delete <branch>`.

# Reference Repos

This project takes inspiration on Pterodactyl's Panel (https://github.com/pterodactyl/panel) and wings (https://github.com/pterodactyl/wings).

References Note: Do not assume that the decisions they make is the correct one. The vision for our project is to be a reimagined pterodactyl, not a pterodactyl clone. We can still learn from them as they have been battletested for millions of users.
