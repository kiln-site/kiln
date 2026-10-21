import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import {
  startPollingWorker,
  stopPollingWorkers,
  wakePollingWorker,
  type WorkerPass,
} from "@/lib/polling-worker"

// A queue of jobs, each due at a time, worked through the way Hearth's
// workers do: a pass does every due job, or reports when the next is due.
function jobQueue() {
  const queued = new Map<string, number>()
  const done: Array<string> = []
  let blockNextPass: Promise<void> | null = null
  const pass = async (): Promise<WorkerPass> => {
    const now = Date.now()
    const due = [...queued].filter(([, at]) => at <= now)
    if (due.length === 0) {
      const next = Math.min(...queued.values())
      return {
        outcome: "idle",
        nextAttemptAt: Number.isFinite(next) ? next : null,
      }
    }
    const blocker = blockNextPass
    blockNextPass = null
    if (blocker) await blocker
    for (const [job] of due) {
      queued.delete(job)
      done.push(job)
    }
    return { outcome: "worked" }
  }
  return {
    done,
    pass,
    queue(job: string, dueInMs = 0) {
      queued.set(job, Date.now() + dueInMs)
    },
    blockNextPass(until: Promise<void>) {
      blockNextPass = until
    },
  }
}

describe("polling worker", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(async () => {
    await stopPollingWorkers()
    vi.useRealTimers()
  })

  it("does a job right away when woken after queueing it", async () => {
    const jobs = jobQueue()
    startPollingWorker("TailscaleCleanup", jobs.pass)
    await vi.advanceTimersByTimeAsync(5_000)

    jobs.queue("remove-network")
    wakePollingWorker("TailscaleCleanup")
    await vi.advanceTimersByTimeAsync(10)

    expect(jobs.done).toEqual(["remove-network"])
  })

  it("does a retry when it's due rather than at the next 30-second check", async () => {
    const jobs = jobQueue()
    jobs.queue("retry", 8_000)
    startPollingWorker("TailscaleCleanup", jobs.pass)

    await vi.advanceTimersByTimeAsync(7_900)
    expect(jobs.done).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(jobs.done).toEqual(["retry"])
  })

  it("does a job queued during a pass right after that pass", async () => {
    const jobs = jobQueue()
    let finishPass = () => {}
    jobs.blockNextPass(
      new Promise((resolve) => {
        finishPass = resolve
      })
    )
    jobs.queue("first")
    startPollingWorker("TailscaleCleanup", jobs.pass)
    await vi.advanceTimersByTimeAsync(10)

    // Queued after the running pass looked for due jobs.
    jobs.queue("second")
    wakePollingWorker("TailscaleCleanup")
    finishPass()
    await vi.advanceTimersByTimeAsync(10)

    expect(jobs.done).toEqual(["first", "second"])
  })

  it("still does a job queued without a wake within 30 seconds", async () => {
    const jobs = jobQueue()
    startPollingWorker("TailscaleCleanup", jobs.pass)
    await vi.advanceTimersByTimeAsync(10)

    jobs.queue("left by an earlier Hearth")
    await vi.advanceTimersByTimeAsync(30_000)

    expect(jobs.done).toEqual(["left by an earlier Hearth"])
  })

  it("keeps working after a pass fails", async () => {
    const jobs = jobQueue()
    let failing = true
    startPollingWorker("TailscaleCleanup", () =>
      failing ? Promise.reject(new Error("MySQL is down")) : jobs.pass()
    )
    await vi.advanceTimersByTimeAsync(10)

    jobs.queue("after the outage")
    failing = false
    await vi.advanceTimersByTimeAsync(2_000)

    expect(jobs.done).toEqual(["after the outage"])
  })
})
