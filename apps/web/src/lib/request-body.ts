/**
 * A request's body as text, read no further than `limit` bytes: null when
 * it's longer, without buffering the rest. For endpoints anyone can reach,
 * where a body without a Content-Length could otherwise be any size.
 */
export async function readLimitedText(
  request: Request,
  limit: number
): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) return null
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}
