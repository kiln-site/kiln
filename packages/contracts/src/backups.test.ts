import { describe, expect, it } from "vite-plus/test"

import { backupArchiveManifestSchema } from "./backups.js"

describe("backup contracts", () => {
  it("keeps v1 archive manifests from before game servers were servers readable", () => {
    expect(
      backupArchiveManifestSchema.safeParse({
        artifactKind: "archive",
        backupId: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-08-20T12:00:00.000Z",
        formatVersion: 1,
        mode: "full",
        target: { id: "instance-1", kind: "instance" },
      }).data?.target
    ).toEqual({ id: "instance-1", kind: "server" })
  })
})
