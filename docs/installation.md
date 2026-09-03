# Install Kiln on Linux

Kiln's installer supports x86_64 and arm64 Linux hosts. It validates Docker,
installs the Docker Engine and Compose v2 when needed, and configures HTTPS with
Coolify's existing proxy or a bundled Traefik edge.

Create DNS records for the host first. With a base domain, Kiln uses
`hearth.<domain>` and `relay.<domain>`:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://kiln.site/install.sh \
  | sudo KILN_DOMAIN=example.com bash -s -- kiln
```

The modes are:

- `kiln`: Hearth, MySQL, Valkey, and a Relay that can run game servers.
- `hearth`: the same platform services with a maintenance Relay that cannot
  provision game servers. Its SFTP listener stays on loopback; the Relay still
  has the platform permissions required for updates and database management.
- `relay`: a standalone Relay. The installer prints a 15-minute pairing URI to
  paste into an existing Hearth.

Set the hostnames separately when they do not share a base domain:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://kiln.site/install.sh \
  | sudo KILN_HEARTH_HOST=panel.example.com \
      KILN_RELAY_HOST=node.example.net bash -s -- kiln
```

Proxy selection defaults to `auto`: a running official `coolify-proxy` is used
when present; otherwise Kiln starts bundled Traefik. An existing installation
keeps its saved proxy choice so a transient Coolify outage cannot silently
switch edges. Override it with `--proxy coolify`, `--proxy traefik`, or an
explicit `--proxy auto` after the mode argument.

Bundled Traefik requires ports 80 and 443. Stop any existing web proxy before
explicitly switching from Coolify to bundled Traefik; the installer refuses to
replace an active listener. Hostnames become immutable after the installer has
verified the public topology. Generated configuration from a failed first
attempt or dry run remains provisional, so its hostnames can be corrected.
Changing a completed installation still requires a Relay-client origin
migration and is rejected before containers are changed.

## Repairs and reinstalls

Rerun the same command to pull `ghcr.io/kiln-site/hearth:latest` and
`ghcr.io/kiln-site/relay:latest`, refresh the Compose definitions, and recreate
the selected containers. The installer deliberately preserves:

- `/opt/kiln/.env` and any settings added to it;
- the `kiln-hearth-mysql` database volume;
- the `kiln-relay-data` volume, including Relay identity, pairing, managed
  server data, and Traefik certificates;
- the installation ID and all generated secrets.

It never runs `docker compose down -v`, deletes a volume, or prunes Docker.
Changing from Coolify to bundled Traefik updates only the persisted proxy mode;
the rest of the Relay configuration and data remains intact.

Switching an existing installation to `relay` stops Hearth, MySQL, and Valkey
without deleting their containers or volumes. A later `kiln` or `hearth` run
starts them again with the saved data.

Kiln links a colocated Relay automatically when it can prove the current
Hearth client identity. If restored or pre-existing state makes automatic
pairing unsafe, the installer prints a fresh 15-minute pairing URI instead of
revoking an existing client. Open Hearth's **Infrastructure → Relays** page,
choose **Add Relay**, paste the URI, and rerun the installer to verify the new
authenticated connection.

Hearth and Relay use HTTPS on ports 80 and 443. Full Kiln and standalone Relay
hosts should also allow TCP 2022 and the configured game-server range (TCP/UDP
30000-39999 by default). MySQL, Valkey, Hearth port 3000, and Relay port 4100
remain private.
