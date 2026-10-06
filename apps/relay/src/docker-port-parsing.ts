/**
 * Parsers for port information Docker and the kernel report as plain text:
 * `docker container ls --format {{.Ports}}` listings and `/proc/net/tcp`.
 */
export function dockerPublishedHostPortsFromListing(
  listing: string,
  protocol: "tcp" | "udp"
): Set<number> {
  const ports = new Set<number>()
  for (const line of listing.split("\n")) {
    for (const rawEntry of line.split(",")) {
      const entry = rawEntry.trim()
      const arrow = entry.indexOf("->")
      if (arrow < 0 || !entry.slice(arrow + 2).endsWith(`/${protocol}`)) {
        continue
      }
      const match = /(?:^|:)(\d+)(?:-(\d+))?$/u.exec(entry.slice(0, arrow))
      if (!match?.[1]) continue
      const start = Number(match[1])
      const end = Number(match[2] ?? match[1])
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end > 65_535 ||
        end < start
      ) {
        continue
      }
      for (let port = start; port <= end; port += 1) ports.add(port)
    }
  }
  return ports
}

export function procNetTcpHasListener(output: string, port: number): boolean {
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0")
  return output.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/u)
    const localAddress = fields[1]
    const state = fields[3]
    return (
      state === "0A" &&
      localAddress?.slice(localAddress.lastIndexOf(":") + 1) === expectedPort
    )
  })
}
