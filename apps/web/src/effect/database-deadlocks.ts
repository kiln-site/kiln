import { Predicate } from "effect"

// MySQL's answer to a transaction it ended to break a deadlock (1213), in
// the error or anything it wraps.
export function isDeadlock(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current != null && depth < 6;
    depth += 1
  ) {
    if (Predicate.hasProperty(current, "errno") && current.errno === 1213) {
      return true
    }
    if (
      Predicate.hasProperty(current, "code") &&
      current.code === "ER_LOCK_DEADLOCK"
    ) {
      return true
    }
    current = Predicate.hasProperty(current, "cause") ? current.cause : null
  }
  return false
}
