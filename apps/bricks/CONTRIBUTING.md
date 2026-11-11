# Contributing a Brick

1. Copy the closest Brick in `bricks/`.
2. Give it a globally recognizable lowercase `metadata.id`.
3. Pin or deliberately channel the container image tag. An App or group
   Brick names the version it runs, such as `:3.4.1`, never `latest`: a
   newer version is a new `revision`, which installs are then offered.
4. Expose every per-deployment customization through `inputs`; never bake
   credentials or server-specific values into a Brick.
5. Add its path to `bricks.yml` and run
   `pnpm --filter @kiln-site/bricks test` from the monorepo root.

Optional Brick icons belong in `icons/` and are linked from the Brick through
`metadata.icon`; do not paste SVG markup into YAML. See
[`icons/README.md`](icons/README.md) for the artwork rules.

Official Bricks must use images with a public source, retain Relay's default
container hardening, and document unusual architecture or port requirements.
Third-party Bricks do not need to be added here: Hearth can deploy an HTTPS
Brick URL directly.

Changes to the meaning of existing fields require a new format. Kiln rejects
unknown fields so typos cannot silently change a deployment. The format is
defined in `packages/contracts/src/brick-recipe.ts`; after changing it, run
`pnpm vp test run src/brick-recipe.test.ts -u` in `packages/contracts` to
regenerate `schema/brick-v2.schema.json`.

Don't edit `catalog.yml` or `recipes/`: they are the retired `kiln.brick/v1`
copies that Relays not yet updated still read.
