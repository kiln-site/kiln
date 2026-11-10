# Kiln Bricks

Bricks are versioned, declarative recipes that tell Kiln how to run
something. This Kiln monorepo app contains the official catalog, reusable
Ember container runtimes, and the public specification.

```text
bricks.yml           the official catalog
bricks/              the official Bricks, in kiln.brick/v2
embers/              reusable OCI runtimes
schema/              machine-readable format schemas
docs/                format and authoring documentation
catalog.yml          the kiln.brick/v1 catalog, kept for Relays not yet updated
recipes/             its kiln.brick/v1 recipes
```

A Brick is intentionally data, not Kiln code. It selects any OCI image,
declares an install form, maps the answers into the environment, and
describes ports and readiness. A Relay that understands the Brick's `format`
can run a new one without being updated.

`catalog.yml` and `recipes/` are frozen. Relays that haven't updated yet read
them from this repository's `main` branch, so they stay until those Relays
are gone. Change a Brick in `bricks/` only.

## Validate locally

```bash
pnpm --filter @kiln-site/bricks test
```

The official catalog is published directly from
`apps/bricks/bricks.yml` on this repository's `main` branch.

## Official Ember images

The official catalog uses prebuilt images published from this repository:

```text
ghcr.io/kiln-site/bricks-java:11
ghcr.io/kiln-site/bricks-java:17
ghcr.io/kiln-site/bricks-java:21
ghcr.io/kiln-site/bricks-java:25
ghcr.io/kiln-site/bricks-steamcmd:latest
```

Bricks may use these images or any other OCI image. Prebuilt official Embers
keep deployments small and repeatable while leaving custom Bricks independent.

See [the specification](docs/brick-v2.md) and the
[contribution guide](CONTRIBUTING.md).
