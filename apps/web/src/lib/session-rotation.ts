import { ensuringPromise } from "@/effect/promise"

// Better Auth replaces the session on some security changes, deleting the old
// one before its response brings the browser the new cookie. In that gap the
// shared cookie is dead: a stream sees its session revoked, requests come back
// signed out, and each cleans up by clearing the cookie, which can land after
// the new one. Every tab shares that cookie, so all of them stay quiet until
// the new one is in place.

export interface SessionStream {
  close: () => void
  open: () => void
}

type RotationMessage = { id: string; type: "ended" | "started" }

// A tab closed mid-rotation never says it ended.
const peerRotationLimitMs = 15_000

const streams = new Set<SessionStream>()
const peerRotations = new Map<string, ReturnType<typeof setTimeout>>()
let rotations = 0
let channel: BroadcastChannel | undefined

function rotationChannel(): BroadcastChannel {
  if (channel) return channel
  channel = new BroadcastChannel("kiln:session-rotation")
  channel.addEventListener(
    "message",
    ({ data }: MessageEvent<RotationMessage>) => {
      if (data.type === "started") startPeerRotation(data.id)
      else endPeerRotation(data.id)
    }
  )
  return channel
}

function startRotation() {
  rotations += 1
  if (rotations === 1) for (const stream of streams) stream.close()
}

function endRotation() {
  rotations -= 1
  if (rotations === 0) for (const stream of streams) stream.open()
}

function startPeerRotation(id: string) {
  if (peerRotations.has(id)) return
  startRotation()
  peerRotations.set(
    id,
    setTimeout(() => endPeerRotation(id), peerRotationLimitMs)
  )
}

function endPeerRotation(id: string) {
  const limit = peerRotations.get(id)
  if (limit === undefined) return
  clearTimeout(limit)
  peerRotations.delete(id)
  endRotation()
}

export function isSessionRotating(): boolean {
  return rotations > 0
}

/** Runs an auth call that replaces the session, holding every tab's streams. */
export function rotateSession<T>(call: () => Promise<T>): Promise<T> {
  const id = crypto.randomUUID()
  rotationChannel().postMessage({ id, type: "started" })
  startRotation()
  return ensuringPromise(call, () => {
    endRotation()
    rotationChannel().postMessage({ id, type: "ended" })
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
