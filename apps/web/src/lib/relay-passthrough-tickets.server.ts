import { verify } from "node:crypto"

import { Option, Schema } from "effect"

import { ensuringPromise, forkPromise, recoverPromise } from "@/effect/promise"

// Tickets: what lets a request through Hearth's pass-through as far as the
// Relay. Every one already carries a credential Hearth signed for that
// Relay with its own key for it: a browser capability, a backup link's
// token, or the grant for a copy another Relay pulls. Hearth checks its own signature, and that the credential is for
// this Relay and this route and still valid, before it spends anything on
// the request, such as a tunnel. The Relay still checks all it does today:
// the browser's proof, nonces, revocation and paths.

// As the Relay bounds a download's form. Forms are read before anyone is
// known, so only a few at once, each for a short while.
const MAX_FORM_BYTES = 2 * 1024 * 1024
const MAX_FORM_READS = 16
const FORM_READ_MS = 10_000
const MAX_CREDENTIAL_BYTES = 16 * 1024

const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      audience: Schema.String,
      expiresAt: Schema.Number,
      issuer: Schema.String,
      // Named by browser capabilities, backup links, and copies' grants.
      instanceId: Schema.optionalKey(Schema.String),
      backupId: Schema.optionalKey(Schema.String),
      transferId: Schema.optionalKey(Schema.String),
    })
  )
)

export interface PassthroughSigner {
  readonly clientId: string
  readonly clientPublicKeyPem: string
}

export type PassthroughTicket =
  // Allowed, with the body as read when finding the credential needed it.
  | { readonly allowed: true; readonly body: Buffer | null }
  // Refused, or, when busy, not looked at for now.
  | { readonly allowed: false; readonly busy?: true }

let formReads = 0

/**
 * Whether a browser's request for `<kind>/<name>` on the Relay carries a
 * credential Hearth signed for it that's still valid.
 */
export async function checkBrowserTicket(input: {
  readonly kind: "backups" | "files"
  readonly name: string
  readonly relayId: string
  readonly request: Request
  readonly signer: PassthroughSigner
}): Promise<PassthroughTicket> {
  const { kind, name, relayId, request, signer } = input
  if (kind === "backups") {
    const token = new URL(request.url).searchParams.get("token") ?? ""
    return signedFor(token, signer, relayId, { backupId: name })
      ? { allowed: true, body: null }
      : { allowed: false }
  }
  let authorization = request.headers.get("authorization")
  let body: Buffer | null = null
  // A native download posts its credentials in a form, which can't set
  // headers; the form is passed on as read.
  if (
    authorization === null &&
    request.method === "POST" &&
    request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  ) {
    if (formReads >= MAX_FORM_READS) return { allowed: false, busy: true }
    formReads += 1
    body = await ensuringPromise(
      () => readBounded(request, MAX_FORM_BYTES, FORM_READ_MS),
      () => {
        formReads -= 1
      }
    )
    if (!body) return { allowed: false }
    authorization = new URLSearchParams(body.toString("utf8")).get(
      "authorization"
    )
  }
  return authorization?.startsWith("Kiln ") &&
    signedFor(authorization.slice(5), signer, relayId, { instanceId: name })
    ? { allowed: true, body }
    : { allowed: false }
}

/**
 * Whether another Relay's pull of a copy from this one carries the grant
 * Hearth signed for that copy.
 */
export function checkPeerTicket(input: {
  readonly relayId: string
  readonly request: Request
  readonly signer: PassthroughSigner
  readonly transferId: string
}): PassthroughTicket {
  const authorization = input.request.headers.get("authorization")
  return authorization?.startsWith("KilnPeer ") &&
    signedFor(authorization.slice(9), input.signer, input.relayId, {
      transferId: input.transferId,
    })
    ? { allowed: true, body: null }
    : { allowed: false }
}

/**
 * Whether `credential`, as `<payload>.<signature>`, is one Hearth signed
 * for this Relay, naming `names`, that hasn't expired.
 */
export function signedFor(
  credential: string,
  signer: PassthroughSigner,
  relayId: string,
  names: {
    readonly backupId?: string
    readonly instanceId?: string
    readonly transferId?: string
  }
): boolean {
  if (credential.length > MAX_CREDENTIAL_BYTES) return false
  const [encoded, signature, extra] = credential.split(".")
  if (!encoded || !signature || extra !== undefined) return false
  const payload = Option.getOrNull(
    decodePayload(Buffer.from(encoded, "base64url").toString("utf8"))
  )
  return (
    payload !== null &&
    payload.audience === relayId &&
    payload.issuer === signer.clientId &&
    payload.expiresAt > Date.now() &&
    (names.backupId === undefined || payload.backupId === names.backupId) &&
    (names.instanceId === undefined ||
      payload.instanceId === names.instanceId) &&
    (names.transferId === undefined ||
      payload.transferId === names.transferId) &&
    verify(
      null,
      Buffer.from(encoded),
      signer.clientPublicKeyPem,
      Buffer.from(signature, "base64url")
    )
  )
}

// The request's body, or null once it's longer than `limit` or takes
// longer than `deadlineMs` to arrive.
async function readBounded(
  request: Request,
  limit: number,
  deadlineMs: number
): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0)
  const chunks: Array<Uint8Array> = []
  let size = 0
  let late = false
  const reader = request.body.getReader()
  const deadline = setTimeout(() => {
    late = true
    forkPromise(() => reader.cancel())
  }, deadlineMs)
  deadline.unref()
  for (;;) {
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- a stream is read in order
    const read = await recoverPromise(
      () => reader.read(),
      () => null
    )
    if (late || read === null) {
      clearTimeout(deadline)
      return null
    }
    if (read.done) {
      clearTimeout(deadline)
      return Buffer.concat(chunks)
    }
    size += read.value.byteLength
    if (size > limit) {
      clearTimeout(deadline)
      forkPromise(() => reader.cancel())
      return null
    }
    chunks.push(read.value)
  }
}
