import { afterEach, describe, expect, it, vi } from "vite-plus/test"

// The Relay is the one thing replaced: each read waits until the test lets
// it finish.
const reads: Array<{
  path: string
  maxBytes: number
  finish: (bytes: number) => void
}> = []
vi.mock("@/lib/relay-file-transfer", () => ({
  readRelayFile: (input: { path: string; maxBytes: number }) =>
    new Promise<Blob>((resolve) => {
      reads.push({
        ...input,
        finish: (bytes) => resolve(new Blob([new Uint8Array(bytes)])),
      })
    }),
}))

import {
  createDocumentImages,
  DOCUMENT_IMAGE_READS_AT_ONCE,
  MAX_DOCUMENT_IMAGES,
  MAX_DOCUMENT_IMAGES_BYTES,
} from "@/components/files/markdown-images"

const root = { instanceId: "server", relayId: "relay" }

afterEach(() => {
  reads.length = 0
})

describe("a document's images", () => {
  it("reads an image once however often the document shows it", async () => {
    const images = createDocumentImages(root)
    for (let index = 0; index < 100; index += 1) {
      images.request("shots/map.png", "image/png")
    }
    await vi.waitFor(() => expect(reads).toHaveLength(1))
    reads[0]?.finish(10)
    await vi.waitFor(() =>
      expect(images.get("shots/map.png")?.status).toBe("ready")
    )
    images.dispose()
  })

  it("reads a few at a time, and every one in the end", async () => {
    const images = createDocumentImages(root)
    for (let index = 0; index < 10; index += 1) {
      images.request(`shots/${index}.png`, "image/png")
    }
    await vi.waitFor(() =>
      expect(reads).toHaveLength(DOCUMENT_IMAGE_READS_AT_ONCE)
    )
    for (let done = 0; done < 10; done += 1) {
      await vi.waitFor(() => expect(reads[done]).toBeDefined())
      expect(reads.length - done).toBeLessThanOrEqual(
        DOCUMENT_IMAGE_READS_AT_ONCE
      )
      reads[done]?.finish(10)
    }
    await vi.waitFor(() =>
      expect(images.get("shots/9.png")?.status).toBe("ready")
    )
    images.dispose()
  })

  it("only links images past what a document may hold", async () => {
    const images = createDocumentImages(root)
    const full = MAX_DOCUMENT_IMAGES_BYTES / DOCUMENT_IMAGE_READS_AT_ONCE
    for (let index = 0; index < DOCUMENT_IMAGE_READS_AT_ONCE; index += 1) {
      images.request(`big/${index}.png`, "image/png")
    }
    await vi.waitFor(() =>
      expect(reads).toHaveLength(DOCUMENT_IMAGE_READS_AT_ONCE)
    )
    // No read may bring more than what's left of the document's budget.
    expect(
      reads.reduce((total, read) => total + read.maxBytes, 0)
    ).toBeLessThanOrEqual(MAX_DOCUMENT_IMAGES_BYTES)
    for (const read of reads) read.finish(full)
    await vi.waitFor(() =>
      expect(images.get("big/3.png")?.status).toBe("ready")
    )

    images.request("more.png", "image/png")

    await vi.waitFor(() =>
      expect(images.get("more.png")?.status).toBe("skipped")
    )
    expect(reads).toHaveLength(DOCUMENT_IMAGE_READS_AT_ONCE)
    images.dispose()
  })

  it("only links images past how many a document may hold", () => {
    const images = createDocumentImages(root)
    for (let index = 0; index <= MAX_DOCUMENT_IMAGES; index += 1) {
      images.request(`shots/${index}.png`, "image/png")
    }

    expect(images.get(`shots/${MAX_DOCUMENT_IMAGES}.png`)?.status).toBe(
      "skipped"
    )
    images.dispose()
  })
})
