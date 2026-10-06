import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import type { ShowToastOptions } from "@workspace/ui/components/sonner"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  showToast: vi.fn(
    (options: ShowToastOptions) => options.id ?? "upload-progress"
  ),
  dismissToast: vi.fn(),
}))

vi.mock("@/lib/relay-file-transfer", () => ({ uploadRelayFile: mocks.upload }))
vi.mock("@workspace/ui/components/sonner", () => ({
  showToast: mocks.showToast,
  dismissToast: mocks.dismissToast,
}))

import { useFileUploadAction, type UploadFiles } from "./file-upload"

let queryClient: QueryClient

const pending = new Map<
  string,
  {
    onProgress: (loaded: number) => void
    resolve: () => void
    reject: (cause: Error) => void
  }
>()

beforeEach(() => {
  queryClient = new QueryClient()
  mocks.upload.mockImplementation(
    ({
      file,
      onProgress,
    }: {
      file: File
      onProgress: (loaded: number) => void
    }) =>
      new Promise<void>((resolve, reject) => {
        pending.set(file.name, { onProgress, resolve, reject })
      })
  )
})

afterEach(() => {
  queryClient.clear()
  pending.clear()
  vi.clearAllMocks()
})

function latestProgressToast() {
  const options = [...mocks.showToast.mock.calls]
    .reverse()
    .find(([options]) => options.type === "loading")?.[0]
  if (!options) throw new Error("No upload progress toast")
  return {
    options,
    title: renderToStaticMarkup(options.message),
    description: renderToStaticMarkup(
      typeof options.description === "function"
        ? options.description()
        : options.description
    ),
    icon: renderToStaticMarkup(options.icon),
  }
}

function startUploads(sizes: ReadonlyArray<number>) {
  const onRefresh = vi.fn()
  let uploadFiles: UploadFiles | undefined
  function UploadHarness() {
    const action = useFileUploadAction({
      canWrite: true,
      instance: {
        id: "instance-one",
        relayId: "relay-one",
      } as InstanceWorkspaceInstance,
      onRefresh,
    })
    uploadFiles = action.uploadFiles
    return null
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <UploadHarness />
    </QueryClientProvider>
  )
  if (!uploadFiles) throw new Error("Upload hook was not rendered")
  const finished = uploadFiles(
    sizes.map((size, index) => ({
      file: new File([new Uint8Array(size)], `file-${index}.txt`),
      path: `file-${index}.txt`,
    })),
    ""
  )
  return { finished, onRefresh }
}

describe("Upload batch progress", () => {
  it("removes failed bytes without shrinking the batch total or counting failures as uploads", async () => {
    const { finished, onRefresh } = startUploads([100, 300, 100])
    await vi.waitFor(() => expect(pending.size).toBe(3))
    expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe(
      "pending"
    )
    const failed = pending.get("file-0.txt")!
    const second = pending.get("file-1.txt")!
    const third = pending.get("file-2.txt")!

    failed.onProgress(100)
    second.onProgress(150)
    failed.reject(new Error("Relay rejected the upload"))

    await vi.waitFor(() =>
      expect(latestProgressToast().description).toContain("1 failed")
    )
    const toast = latestProgressToast()
    expect(toast.title).toContain("0/3")
    expect(toast.title).toContain("30%")
    expect(toast.description).toContain("file-1.txt")
    expect(toast.icon).toContain('aria-valuenow="50"')

    // Late callbacks must not restore bytes from a settled upload.
    failed.onProgress(100)
    second.resolve()
    await vi.waitFor(() => expect(latestProgressToast().title).toContain("1/3"))
    expect(latestProgressToast().title).toContain("60%")
    second.onProgress(0)
    third.onProgress(50)
    await vi.waitFor(() => expect(latestProgressToast().title).toContain("70%"))
    third.resolve()
    await finished

    expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe(
      "success"
    )

    // The batch ends as a failure that surfaces the Relay's reason.
    expect(mocks.showToast.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "error",
      description: "Relay rejected the upload",
    })
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it("keeps failed empty files at zero progress and reports an all-failed batch", async () => {
    const { finished, onRefresh } = startUploads([0, 0, 0])
    await vi.waitFor(() => expect(pending.size).toBe(3))
    pending.get("file-0.txt")!.reject(new Error("Upload denied"))
    await vi.waitFor(() =>
      expect(latestProgressToast().description).toContain("1 failed")
    )
    expect(latestProgressToast().title).toContain("0%")
    expect(latestProgressToast().title).toContain("0/3")

    pending.get("file-1.txt")!.reject(new Error("Upload denied"))
    pending.get("file-2.txt")!.reject(new Error("Upload denied"))
    await finished

    expect(mocks.showToast.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "error",
    })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("does not double count bytes when a file restarts through Hearth", async () => {
    const { finished } = startUploads([100, 100])
    await vi.waitFor(() => expect(pending.size).toBe(2))
    const first = pending.get("file-0.txt")!
    const second = pending.get("file-1.txt")!
    first.onProgress(100)
    first.onProgress(0)
    second.onProgress(60)
    await vi.waitFor(() => expect(latestProgressToast().title).toContain("30%"))
    expect(latestProgressToast().icon).toContain('aria-valuenow="0"')

    second.resolve()
    await vi.waitFor(() => expect(latestProgressToast().title).toContain("1/2"))
    expect(latestProgressToast().title).toContain("50%")
    first.resolve()
    await finished

    expect(mocks.showToast.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "success",
    })
  })
})
