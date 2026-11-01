# Kiln Bricks

Bricks are versioned, declarative packages that tell a Kiln Relay how to run a
server. This Kiln monorepo app contains the official catalog, reusable Ember
container runtimes, and the public recipe specification.

```text
catalog.yml          official recipe index
embers/              reusable OCI runtimes
recipes/             official kiln.brick/v1 recipes
schema/              machine-readable format schemas
docs/                format and authoring documentation
```

A recipe is intentionally data, not Relay code. It selects any OCI image,
declares user-configurable variables, maps them into environment and resource
settings, and describes ports and routing. A Relay that understands the recipe's
`format` can run a new Brick without being updated.

## Validate locally

```bash
pnpm --filter @kiln-site/bricks test
```

The official catalog is published directly from
`apps/bricks/catalog.yml` on this repository's `main` branch.

## Official Ember images

The official catalog uses prebuilt images published from this repository:

```text
ghcr.io/kiln-site/bricks-java:11
ghcr.io/kiln-site/bricks-java:17
ghcr.io/kiln-site/bricks-java:21
ghcr.io/kiln-site/bricks-java:25
ghcr.io/kiln-site/bricks-steamcmd:latest
```

Recipes may use these images or any other OCI image. Prebuilt official Embers
keep deployments small and repeatable while leaving custom Bricks independent.

See [the v1 specification](docs/recipe-v1.md) and
[contribution guide](CONTRIBUTING.md).
