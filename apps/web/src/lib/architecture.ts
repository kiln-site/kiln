/** A CPU architecture by the name Docker gives it, whatever it was called. */
export function normalizeArchitecture(architecture: string): string {
  switch (architecture.trim().toLowerCase()) {
    case "x64":
    case "x86-64":
    case "x86_64":
      return "amd64"
    case "aarch64":
      return "arm64"
    default:
      return architecture.trim().toLowerCase()
  }
}
