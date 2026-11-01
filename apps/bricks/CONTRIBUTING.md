# Contributing a Brick

1. Copy the closest recipe in `recipes/`.
2. Give it a globally recognizable lowercase `metadata.id`.
3. Pin or deliberately channel the container image tag.
4. Expose every per-deployment customization through `variables`; never bake
   credentials or server-specific values into a recipe.
5. Add the recipe path to `catalog.yml` and run
   `pnpm --filter @kiln-site/bricks test` from the monorepo root.

Optional Brick icons belong in `icons/` and are linked from the recipe through
`metadata.icon`; do not paste SVG markup into YAML. See
[`icons/README.md`](icons/README.md) for the artwork rules.

Official recipes must use images with a public source, retain Relay's default
container hardening, and document unusual architecture or port requirements.
Third-party recipes do not need to be added here: Hearth can deploy an HTTPS
recipe URL directly.

Changes to the meaning of existing fields require a new format. Additive recipe
content must continue to validate under `kiln.brick/v1`; Relay rejects unknown
fields so typos cannot silently change a deployment.
