// Commit handshake between the Relay and a database worker process. Shared by
// both sides; the worker module itself must not be imported by the Relay.
export const COMMIT_CHANNEL_FD = 3
export const COMMIT_REQUEST = "C"
export const COMMIT_GRANTED = "Y"
