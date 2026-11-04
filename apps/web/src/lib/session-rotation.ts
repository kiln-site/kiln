import { ensuringPromise } from "@/effect/promise"

// Better Auth replaces the session on some security changes, deleting the old
// one before its response brings the browser the new cookie. In that gap the
// shared cookie is dead: a stream sees its session revoked, requests come back
// signed out, and each cleans up by clearing the cookie, which can land after
// the new one. Every tab shares that cookie, so all of them hold their streams
// and new requests until the new one is in place.

export interface SessionStream {
  close: () => void
  open: () => void
}

type RotationMessage = { id: string; type: "ended" | "started" }

// A tab closed mid-rotation never says it ended, and a stalled call must not
// leave a tab without realtime or sign-out handling. A rotation takes moments.
const rotationLimitMs = 15_000

const streams = new Set<SessionStream>()
const rotations = new Map<string, ReturnType<typeof setTimeout>>()
let settled = Promise.resolve()
let settle = () => {}
let channel: BroadcastChannel | undefined

function rotationChannel(): BroadcastChannel | undefined {
  if (channel || typeof BroadcastChannel === "undefined") return channel
  channel = new BroadcastChannel("kiln:session-rotation")
  channel.addEventListener(
    "message",
    ({ data }: MessageEvent<RotationMessage>) => {
      if (data.type === "started") startRotation(data.id)
      else endRotation(data.id)
    }
  )
  return channel
}

function startRotation(id: string) {
  if (rotations.has(id)) return
  if (rotations.size === 0) {
    settled = new Promise((resolve) => {
      settle = resolve
    })
    for (const stream of streams) stream.close()
  }
  rotations.set(
    id,
    setTimeout(() => endRotation(id), rotationLimitMs)
  )
}

function endRotation(id: string) {
  const limit = rotations.get(id)
  if (limit === undefined) return
  clearTimeout(limit)
  rotations.delete(id)
  if (rotations.size > 0) return
  settle()
  for (const stream of streams) stream.open()
}

export function isSessionRotating(): boolean {
  return rotations.size > 0
}

/** Resolves once no tab is replacing the session, at once if none is. */
export function sessionRotationSettled(): Promise<void> {
  return settled
}

/** Runs an auth call that replaces the session, holding every tab. */
export function rotateSession<T>(call: () => Promise<T>): Promise<T> {
  const id = crypto.randomUUID()
  rotationChannel()?.postMessage({ id, type: "started" })
  startRotation(id)
  return ensuringPromise(call, () => {
    endRotation(id)
    rotationChannel()?.postMessage({ id, type: "ended" })
  })
}

/**
 * Keeps a stream open except during a rotation: it would be authenticated by
 * the cookie being replaced. Reopening uses the new one. Returns a function
 * that closes the stream for good.
 */
export function holdStreamAcrossSessionRotation(
  stream: SessionStream
): () => void {
  rotationChannel()
  streams.add(stream)
  if (!isSessionRotating()) stream.open()
  return () => {
    streams.delete(stream)
    stream.close()
  }
}
