// An App's environment is kept as text, a variable to a line, as someone
// writes it. These read and change it by variable, the way a Relay reads it
// when it deploys: a line that isn't `NAME=value` sets nothing, a later line
// wins, and a value in matching quotes is what is inside them.

const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u

function unquoted(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  return trimmed.length >= 2 &&
    (quote === '"' || quote === "'") &&
    trimmed.at(-1) === quote
    ? trimmed.slice(1, -1)
    : trimmed
}

const assigned = (line: string) => {
  const text = line.trim()
  return text.startsWith("#") ? null : (assignment.exec(text) ?? null)
}

/** The variables an environment sets, each with the value a container gets. */
export function appEnvironmentVariables(
  environment: string
): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const line of environment.split("\n")) {
    const match = assigned(line)
    if (match?.[1] !== undefined) variables[match[1]] = unquoted(match[2] ?? "")
  }
  return variables
}

/**
 * An environment without the variables removed, and with those set written
 * in at its end. Every other line stays as it was written, comments too. A
 * variable set here replaces any line that set it before.
 */
export function appEnvironmentWith(
  environment: string,
  remove: Iterable<string>,
  set: Readonly<Record<string, string>>
): string {
  const gone = new Set([...remove, ...Object.keys(set)])
  const kept = environment
    .split("\n")
    .filter((line) => !gone.has(assigned(line)?.[1] ?? ""))
  // Without the blank lines a file ends with, so it grows by its new lines.
  while (kept.at(-1)?.trim() === "") kept.pop()
  const lines = [
    ...kept,
    ...Object.entries(set).map(
      ([name, value]) =>
        // Quoted when reading it back bare would give another value.
        `${name}=${unquoted(value) === value ? value : `"${value}"`}`
    ),
  ]
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}
