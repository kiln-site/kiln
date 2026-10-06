/**
 * Turns provisioning failures (often wrapped Docker CLI errors) into a message
 * that is safe and useful to show in Hearth: known Docker failures get
 * actionable guidance, and raw `Command failed:` lines are never exposed.
 */
const EFFECT_PROMISE_FAILURE = "An error occurred in Effect.tryPromise"

export function provisioningErrorMessage(cause: unknown): string {
  const messages = errorMessages(cause)
  const combined = messages.join("\n").toLowerCase()

  if (
    combined.includes("all predefined address pools have been fully subnetted")
  ) {
    return "Docker could not create Kiln's private server network because all default address pools are in use. Remove unused Docker networks or expand Docker's default-address-pools, then provision the server again."
  }
  if (combined.includes("no space left on device")) {
    return "The Relay ran out of disk space while building this server. Free disk space on the Relay, then provision the server again."
  }
  if (
    combined.includes("port is already allocated") ||
    combined.includes("address already in use")
  ) {
    return "Docker could not bind a required server port because it is already in use. Free the conflicting port on the Relay, then provision the server again."
  }
  if (
    combined.includes("permission denied") &&
    (combined.includes("docker.sock") || combined.includes("docker daemon"))
  ) {
    return "The Relay does not have permission to use Docker. Restore Docker access for the Relay service, then provision the server again."
  }

  const message = [...messages]
    .reverse()
    .find((candidate) => candidate !== EFFECT_PROMISE_FAILURE)
  if (!message) return "The Relay could not finish provisioning this server."

  const detail = message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => !line.startsWith("Command failed:"))
  return (detail ?? message).slice(0, 2_048)
}

function errorMessages(cause: unknown): Array<string> {
  const messages: Array<string> = []
  const seen = new Set<object>()
  let current = cause

  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) break
    seen.add(current)
    if (
      "message" in current &&
      typeof current.message === "string" &&
      current.message.trim()
    ) {
      messages.push(current.message.trim())
    }
    current = "cause" in current ? current.cause : undefined
  }

  return messages
}
