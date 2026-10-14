/** Parses the TCP sockets the kernel reports in `/proc/net/tcp`. */
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
