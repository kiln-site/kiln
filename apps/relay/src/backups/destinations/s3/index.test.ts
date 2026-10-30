import { describe, expect, it } from "vite-plus/test"

import type { BackupS3CredentialUploadDestination } from "@workspace/contracts"

import { signS3CredentialUpload } from "./index.js"

const destination = {
  accessKeyId: "AKIDEXAMPLE",
  allowPrivateNetwork: false,
  artifactId: "10000000-0000-4000-8000-000000000001",
  bucket: "kiln-backups",
  endpoint: "https://s3.example.com",
  forcePathStyle: false,
  kind: "s3",
  objectKey: "team/kiln/backup one.zip",
  region: "us-east-1",
  secretAccessKey: "secret-example",
} satisfies BackupS3CredentialUploadDestination

describe("scheduled S3 archive uploads", () => {
  it("signs a deterministic virtual-hosted PUT without exposing credentials", () => {
    const request = signS3CredentialUpload(
      destination,
      "a".repeat(64),
      new Date("2026-08-22T12:34:56.000Z")
    )

    expect(request.url).toBe(
      "https://kiln-backups.s3.example.com/team/kiln/backup%20one.zip"
    )
    expect(request.headers).toMatchObject({
      "content-type": "application/zip",
      "x-amz-content-sha256": "a".repeat(64),
      "x-amz-date": "20260822T123456Z",
    })
    expect(request.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260822\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/u
    )
    expect(JSON.stringify(request)).not.toContain("secret-example")
  })
})
