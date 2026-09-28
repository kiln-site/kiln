// node:sqlite cannot interrupt a running statement, and terminating a worker
// only takes effect once the statement returns, so a timeout cannot stop
// SQLite directly. Instead every job shares this flag with its worker: the
// Relay cancels by flipping it, the worker checks it between steps, and a
// commit must claim it first. Whichever side flips it first wins, so a
// cancelled job can never commit.
export const JOB_PENDING = 0
export const JOB_CANCELLED = 1
export const JOB_COMMITTING = 2

export function createJobControl() {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
}

// Returns false when the worker already started committing, in which case
// the caller has to wait for the commit to report its outcome.
export function cancelJob(control: Int32Array) {
  return (
    Atomics.compareExchange(control, 0, JOB_PENDING, JOB_CANCELLED) !==
    JOB_COMMITTING
  )
}

export function isJobCancelled(control: Int32Array) {
  return Atomics.load(control, 0) === JOB_CANCELLED
}

export function claimJobCommit(control: Int32Array) {
  const previous = Atomics.compareExchange(
    control,
    0,
    JOB_PENDING,
    JOB_COMMITTING
  )
  return previous !== JOB_CANCELLED
}
