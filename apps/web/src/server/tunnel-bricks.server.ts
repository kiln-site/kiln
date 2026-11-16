import {
  tunnelBrickProblem,
  type Brick,
  type TunnelApply as GatewayApply,
} from "@workspace/contracts"

import { defaultBrickCatalog } from "@/server/brick-catalogs.server"

// The Bricks a tunnel is made from: the tunnel Bricks of Kiln's own
// catalog, each of a type Kiln runs, from that type's images. Another
// catalog's aren't offered or accepted: a tunnel's login, routes, firewall
// and DNS are Kiln's, made for these images, which is more than a recipe
// can be checked for. The Relay checks what it can.

/** Every tunnel Brick a tunnel may be made from. */
export async function tunnelBricks(): Promise<Array<Brick>> {
  const catalog = await defaultBrickCatalog()
  return (catalog?.bricks ?? []).filter(
    (brick) => tunnelBrickProblem(brick) === null
  )
}

/** The tunnel Brick at a source, as its Relay takes it. */
export async function requiredTunnelBrick(
  source: string
): Promise<NonNullable<GatewayApply["brick"]>> {
  const brick = (await tunnelBricks()).find(
    (candidate) => candidate.source === source
  )
  if (!brick) throw new Error("This isn't one of Kiln's tunnel Bricks")
  const { iconSvg: _iconSvg, source: _source, ...definition } = brick
  return { definition, source }
}

/**
 * Kiln's own `tailscale` tunnel Brick, by source: what a tunnel made before
 * tunnels had Bricks runs.
 */
export async function officialTunnelBrickSource(): Promise<string> {
  const brick = (await tunnelBricks()).find(
    (candidate) => candidate.type === "tailscale"
  )
  if (!brick) throw new Error("Kiln's catalog has no Tailscale tunnel Brick")
  return brick.source
}
