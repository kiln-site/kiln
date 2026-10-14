/**
 * Names a request span by its server function, or by its path with
 * identifier segments replaced, so span names stay a small, stable set.
 */
export function requestSpanName(
  method: string,
  pathname: string,
  serverFn?: { readonly filename: string; readonly name: string }
): string {
  if (serverFn) {
    return `${serverFn.filename.split("/").at(-1)}:${serverFn.name}`
  }
  const path = pathname
    .split("/")
    .map((segment) => (isIdentifierSegment(segment) ? ":id" : segment))
    .join("/")
  return `${method} ${path}`
}

function isIdentifierSegment(segment: string): boolean {
  return (
    /^\d+$/u.test(segment) ||
    (segment.length >= 8 && /\d/u.test(segment)) ||
    segment.length > 32
  )
}
