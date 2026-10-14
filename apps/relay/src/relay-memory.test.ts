import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

// The cgroup filesystem is the one external boundary relay-memory reads.
const cgroup = vi.hoisted(() => ({
  currentError: null as NodeJS.ErrnoException | null,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...filesystem,
    readFile: async (path: string) => {
      if (!path.startsWith("/sys/fs/cgroup/")) {
        throw new Error(`Unexpected read of ${path}`)
      }
      if (path.endsWith("/memory.current")) {
        if (cgroup.currentError) throw cgroup.currentError
        return "300\n"
      }
      if (path.endsWith("/memory.max")) return "max\n"
      return "anon 200\nfile 100\nactive_file 40\ninactive_file 60\nkernel 0\n"
    },
  }
})

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

async function sampler() {
  vi.resetModules()
  const { relayProcessMemory } = await import("./relay-memory.js")
  return async () => (await relayProcessMemory()).container
}

describe("Relay container memory", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    cgroup.currentError = null
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("recovers the cgroup breakdown after a transient read failure", async () => {
    const container = await sampler()
    cgroup.currentError = errno("EMFILE")
    expect(await container()).toBeNull()

    cgroup.currentError = null
    vi.advanceTimersByTime(5_000)
    expect(await container()).toEqual({
      activeFileBytes: 40,
      anonBytes: 200,
      fileBytes: 100,
      inactiveFileBytes: 60,
      kernelBytes: 0,
      limitBytes: null,
      usedBytes: 300,
    })
  })
})
