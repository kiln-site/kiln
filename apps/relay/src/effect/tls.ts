import "reflect-metadata"

import {
  createPrivateKey,
  randomUUID,
  webcrypto,
  X509Certificate as NodeX509Certificate,
} from "node:crypto"
import { chmod, mkdir, readFile, rm } from "node:fs/promises"
import { isIP } from "node:net"
import { join } from "node:path"
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509"
import { Effect } from "effect"

import { RelayTlsError } from "./errors.js"
import { writeFileAtomic as atomicWriteFile } from "./atomic-file.js"
import type { RelayConfig, RelayTlsMode } from "../config.js"

const CA_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1_000
const LEAF_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000
const LEAF_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000

export interface RelayTlsMaterial {
  readonly caCertificatePem: string | null
  readonly certificatePem: string
  readonly expiresAt: number
  readonly fingerprint: string
  readonly keyPem: string
  readonly mode: Exclude<RelayTlsMode, "development">
}

export const loadRelayTls = Effect.fn("RelayTls.load")(function* (
  config: RelayConfig,
  now = Date.now()
) {
  // The selected Traefik edge owns the public certificate and forwards over a
  // private Docker network. Loading a second certificate here would make the
  // upstream protocol disagree with the route generated for port 4100.
  if (config.proxyMode === "coolify" || config.proxyMode === "traefik") {
    return null
  }
  if (config.tlsMode === "development") return null
  if (config.tlsMode === "external") {
    return yield* loadExternalTls(config, now)
  }
  return yield* loadOrCreateManagedTls(config, now)
})

const loadExternalTls = Effect.fn("RelayTls.loadExternal")(function* (
  config: RelayConfig,
  now: number
) {
  if (!config.tlsCertificatePath || !config.tlsKeyPath) {
    return yield* Effect.fail(
      RelayTlsError.make({
        operation: "external_configuration",
        cause: new Error("External TLS certificate paths are missing"),
      })
    )
  }
  const [certificatePem, keyPem] = yield* Effect.all([
    readText(config.tlsCertificatePath, "read_external_certificate"),
    readText(config.tlsKeyPath, "read_external_key"),
  ])
  return yield* validateMaterial({
    advertisedHost: config.advertisedHost,
    caCertificatePem: null,
    certificatePem,
    keyPem,
    minimumExpiry: now + 60_000,
    mode: "external",
    now,
  })
})

const loadOrCreateManagedTls = Effect.fn("RelayTls.loadOrCreateManaged")(
  function* (config: RelayConfig, now: number) {
    const directory = join(config.dataDirectory, "network", "tls")
    const caCertificatePath = join(directory, "ca.crt")
    const caKeyPath = join(directory, "ca.key")
    const certificatePath = join(directory, "relay.crt")
    const keyPath = join(directory, "relay.key")
    yield* tryPromise("create_tls_directory", () =>
      mkdir(directory, { recursive: true, mode: 0o700 })
    )

    const ca = yield* loadManagedCa(caCertificatePath, caKeyPath, now).pipe(
      Effect.catchIf(
        (error) => error.operation === "managed_ca_missing",
        () => createManagedCa(caCertificatePath, caKeyPath, now)
      )
    )

    const existing = yield* loadManagedLeaf(
      config,
      ca.certificatePem,
      certificatePath,
      keyPath,
      now
    ).pipe(
      Effect.catchIf(
        (error) =>
          error.operation === "managed_leaf_missing" ||
          error.operation === "managed_leaf_renewal_required",
        () => Effect.succeed(null)
      )
    )
    if (existing) return existing

    return yield* createManagedLeaf({
      advertisedHost: config.advertisedHost,
      caCertificatePem: ca.certificatePem,
      caKeyPem: ca.keyPem,
      certificatePath,
      keyPath,
      now,
    })
  }
)

/**
 * The private authority the Relay's certificates come from, which Hearth
 * pins, for a platform backup to carry to a new machine; null when the
 * Relay never made one, behind a proxy or with the operator's certificate.
 */
export const readRelayCertificateAuthority = Effect.fn("RelayTls.readCa")(
  function* (config: RelayConfig) {
    const directory = join(config.dataDirectory, "network", "tls")
    return yield* readPair(
      join(directory, "ca.crt"),
      join(directory, "ca.key"),
      "managed_ca_missing",
      "read_managed_ca"
    ).pipe(
      Effect.catchIf(
        (error) => error.operation === "managed_ca_missing",
        () => Effect.succeed(null)
      )
    )
  }
)

/**
 * Takes on a lost Relay's TLS authority, which the restored Hearth pins. The
 * certificate it issued here is removed, so the next start issues one from
 * the restored authority.
 */
export const writeRelayCertificateAuthority = Effect.fn("RelayTls.writeCa")(
  function* (
    config: RelayConfig,
    authority: { readonly certificatePem: string; readonly keyPem: string }
  ) {
    const directory = join(config.dataDirectory, "network", "tls")
    yield* tryPromise("create_tls_directory", () =>
      mkdir(directory, { recursive: true, mode: 0o700 })
    )
    yield* tryPromise("remove_tls_leaf", () =>
      Promise.all([
        rm(join(directory, "relay.crt"), { force: true }),
        rm(join(directory, "relay.key"), { force: true }),
      ])
    )
    yield* writeFileAtomic(join(directory, "ca.key"), authority.keyPem, 0o600)
    yield* writeFileAtomic(
      join(directory, "ca.crt"),
      authority.certificatePem,
      0o644
    )
  }
)

const loadManagedCa = Effect.fn("RelayTls.loadManagedCa")(function* (
  certificatePath: string,
  keyPath: string,
  now: number
) {
  const files = yield* readPair(
    certificatePath,
    keyPath,
    "managed_ca_missing",
    "read_managed_ca"
  )
  yield* protectKey(keyPath)
  const certificate = yield* parseCertificate(files.certificatePem, "parse_ca")
  if (Date.parse(certificate.validTo) < now + LEAF_LIFETIME_MS) {
    return yield* Effect.fail(
      RelayTlsError.make({
        operation: "managed_ca_expiring",
        cause: new Error("The Relay private CA must be rotated explicitly"),
      })
    )
  }
  yield* validateKeyPair(certificate, files.keyPem, "validate_ca_key")
  return files
})

const createManagedCa = Effect.fn("RelayTls.createManagedCa")(function* (
  certificatePath: string,
  keyPath: string,
  now: number
) {
  const keys = yield* generateEcdsaKeyPair()
  const subjectKeyIdentifier = yield* tryPromise("create_ca_key_id", () =>
    SubjectKeyIdentifierExtension.create(keys.publicKey, false, webcrypto)
  )
  const certificate = yield* tryPromise("create_ca_certificate", () =>
    X509CertificateGenerator.createSelfSigned(
      {
        extensions: [
          new BasicConstraintsExtension(true, 0, true),
          new KeyUsagesExtension(
            KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
            true
          ),
          subjectKeyIdentifier,
        ],
        keys,
        name: "CN=Kiln Relay Local CA",
        notAfter: new Date(now + CA_LIFETIME_MS),
        notBefore: new Date(now - 5 * 60_000),
        serialNumber: randomSerialNumber(),
        signingAlgorithm: { hash: "SHA-256", name: "ECDSA" },
      },
      webcrypto
    )
  )
  const certificatePem = certificate.toString("pem")
  const keyPem = yield* exportPrivateKey(keys.privateKey)
  yield* writeFileAtomic(keyPath, keyPem, 0o600)
  yield* writeFileAtomic(certificatePath, certificatePem, 0o644)
  return { certificatePem, keyPem }
})

const loadManagedLeaf = Effect.fn("RelayTls.loadManagedLeaf")(function* (
  config: RelayConfig,
  caCertificatePem: string,
  certificatePath: string,
  keyPath: string,
  now: number
) {
  const files = yield* readPair(
    certificatePath,
    keyPath,
    "managed_leaf_missing",
    "read_managed_leaf"
  )
  yield* protectKey(keyPath)
  const material = yield* validateMaterial({
    advertisedHost: config.advertisedHost,
    caCertificatePem,
    certificatePem: files.certificatePem,
    keyPem: files.keyPem,
    minimumExpiry: now + LEAF_RENEWAL_WINDOW_MS,
    mode: "managed",
    now,
  }).pipe(
    Effect.mapError((error) =>
      RelayTlsError.make({
        operation: "managed_leaf_renewal_required",
        cause: error,
      })
    )
  )
  return material
})

const createManagedLeaf = Effect.fn("RelayTls.createManagedLeaf")(
  function* (input: {
    readonly advertisedHost: string
    readonly caCertificatePem: string
    readonly caKeyPem: string
    readonly certificatePath: string
    readonly keyPath: string
    readonly now: number
  }) {
    const caCertificate = yield* parseX509Certificate(
      input.caCertificatePem,
      "parse_ca_certificate"
    )
    const caPrivateKey = yield* importPrivateKey(input.caKeyPem)
    const keys = yield* generateEcdsaKeyPair()
    const subjectKeyIdentifier = yield* tryPromise("create_leaf_key_id", () =>
      SubjectKeyIdentifierExtension.create(keys.publicKey, false, webcrypto)
    )
    const sanType = isIP(input.advertisedHost) ? "ip" : "dns"
    const certificate = yield* tryPromise("create_leaf_certificate", () =>
      X509CertificateGenerator.create(
        {
          extensions: [
            new BasicConstraintsExtension(false, undefined, true),
            new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
            new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
            new SubjectAlternativeNameExtension([
              { type: sanType, value: input.advertisedHost },
            ]),
            subjectKeyIdentifier,
          ],
          issuer: caCertificate.subject,
          notAfter: new Date(input.now + LEAF_LIFETIME_MS),
          notBefore: new Date(input.now - 5 * 60_000),
          publicKey: keys.publicKey,
          serialNumber: randomSerialNumber(),
          signingAlgorithm: { hash: "SHA-256", name: "ECDSA" },
          signingKey: caPrivateKey,
          subject: `CN=${input.advertisedHost}`,
        },
        webcrypto
      )
    )
    const leafCertificatePem = certificate.toString("pem")
    const keyPem = yield* exportPrivateKey(keys.privateKey)
    yield* writeFileAtomic(input.keyPath, keyPem, 0o600)
    yield* writeFileAtomic(input.certificatePath, leafCertificatePem, 0o644)
    return yield* validateMaterial({
      advertisedHost: input.advertisedHost,
      caCertificatePem: input.caCertificatePem,
      certificatePem: leafCertificatePem,
      keyPem,
      minimumExpiry: input.now + LEAF_RENEWAL_WINDOW_MS,
      mode: "managed",
      now: input.now,
    })
  }
)

const validateMaterial = Effect.fn("RelayTls.validateMaterial")(
  function* (input: {
    readonly advertisedHost: string
    readonly caCertificatePem: string | null
    readonly certificatePem: string
    readonly keyPem: string
    readonly minimumExpiry: number
    readonly mode: "external" | "managed"
    readonly now: number
  }) {
    const certificate = yield* parseCertificate(
      input.certificatePem,
      "parse_certificate"
    )
    yield* validateKeyPair(
      certificate,
      input.keyPem,
      "validate_certificate_key"
    )
    const validFrom = Date.parse(certificate.validFrom)
    if (!Number.isFinite(validFrom) || validFrom > input.now) {
      return yield* Effect.fail(
        RelayTlsError.make({
          operation: "validate_certificate_not_yet_valid",
          cause: new Error("TLS certificate is not valid yet"),
        })
      )
    }
    if (input.mode === "managed" && input.caCertificatePem) {
      const caCertificate = yield* parseCertificate(
        input.caCertificatePem,
        "parse_managed_ca_certificate"
      )
      const issuedByCa = yield* Effect.try({
        try: () =>
          certificate.checkIssued(caCertificate) &&
          certificate.verify(caCertificate.publicKey),
        catch: (cause) =>
          RelayTlsError.make({ operation: "validate_managed_chain", cause }),
      })
      if (!issuedByCa) {
        return yield* Effect.fail(
          RelayTlsError.make({
            operation: "validate_managed_chain",
            cause: new Error(
              "Managed TLS certificate was not issued by the current Relay CA"
            ),
          })
        )
      }
    }
    const expiresAt = Date.parse(certificate.validTo)
    if (expiresAt <= input.minimumExpiry) {
      return yield* Effect.fail(
        RelayTlsError.make({
          operation: "validate_certificate_expiry",
          cause: new Error("TLS certificate expires inside the renewal window"),
        })
      )
    }
    const hostMatch = isIP(input.advertisedHost)
      ? certificate.checkIP(input.advertisedHost)
      : certificate.checkHost(input.advertisedHost)
    if (!hostMatch) {
      return yield* Effect.fail(
        RelayTlsError.make({
          operation: "validate_certificate_host",
          cause: new Error("TLS certificate does not match KILN_RELAY_HOST"),
        })
      )
    }
    return {
      caCertificatePem: input.caCertificatePem,
      certificatePem:
        input.mode === "managed" && input.caCertificatePem
          ? `${input.certificatePem.trim()}\n${input.caCertificatePem.trim()}\n`
          : input.certificatePem,
      expiresAt,
      fingerprint: certificate.fingerprint256,
      keyPem: input.keyPem,
      mode: input.mode,
    } satisfies RelayTlsMaterial
  }
)

function generateEcdsaKeyPair() {
  return tryPromise("generate_tls_key", () =>
    webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])
  )
}

function exportPrivateKey(key: webcrypto.CryptoKey) {
  return tryPromise("export_tls_key", async () => {
    const encoded = await webcrypto.subtle.exportKey("pkcs8", key)
    return PemConverter.encode(encoded, "PRIVATE KEY")
  })
}

function importPrivateKey(value: string) {
  return tryPromise("import_tls_key", () =>
    webcrypto.subtle.importKey(
      "pkcs8",
      PemConverter.decodeFirst(value),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    )
  )
}

function parseX509Certificate(value: string, operation: string) {
  return Effect.try({
    try: () => new X509Certificate(value),
    catch: (cause) => RelayTlsError.make({ operation, cause }),
  })
}

function parseCertificate(value: string, operation: string) {
  return Effect.try({
    try: () => new NodeX509Certificate(value),
    catch: (cause) => RelayTlsError.make({ operation, cause }),
  })
}

function validateKeyPair(
  certificate: NodeX509Certificate,
  keyPem: string,
  operation: string
) {
  return Effect.try({
    try: () => {
      if (!certificate.checkPrivateKey(createPrivateKey(keyPem))) {
        throw new Error("TLS certificate and private key do not match")
      }
    },
    catch: (cause) => RelayTlsError.make({ operation, cause }),
  })
}

function readPair(
  certificatePath: string,
  keyPath: string,
  missingOperation: string,
  readOperation: string
) {
  return Effect.tryPromise({
    try: async () => {
      const [certificatePem, keyPem] = await Promise.all([
        readFile(certificatePath, "utf8"),
        readFile(keyPath, "utf8"),
      ])
      return { certificatePem, keyPem }
    },
    catch: (cause) =>
      RelayTlsError.make({
        operation: isMissingFile(cause) ? missingOperation : readOperation,
        cause,
      }),
  })
}

function readText(path: string, operation: string) {
  return tryPromise(operation, () => readFile(path, "utf8"))
}

function protectKey(path: string) {
  return tryPromise("protect_tls_key", () => chmod(path, 0o600))
}

function writeFileAtomic(path: string, value: string, mode: number) {
  return atomicWriteFile(path, value, mode).pipe(
    Effect.mapError((cause) =>
      RelayTlsError.make({ operation: "write_tls_file", cause })
    ),
    Effect.withSpan("relay.tls.write_tls_file")
  )
}

function randomSerialNumber(): string {
  return randomUUID().replaceAll("-", "")
}

function tryPromise<T>(operation: string, run: () => Promise<T>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => RelayTlsError.make({ operation, cause }),
  }).pipe(Effect.withSpan(`relay.tls.${operation}`))
}

function isMissingFile(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === "ENOENT"
  )
}
