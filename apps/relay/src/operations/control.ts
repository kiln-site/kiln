/**
 * Hearth's control requests that run as operations: each names its
 * definition and how its input comes from the request. The control socket
 * reserves its place in line on arrival and runs it (control-socket.ts).
 */
import type {
  RelayControlOperation,
  RelayControlRequest,
} from "@workspace/contracts"

import type { RelayOperation } from "./operation.js"

/** A control request that runs as an operation (operations/operation.ts). */
export interface ControlOperation {
  readonly definition: RelayOperation<unknown, unknown, unknown, never>
  /** Its input, from the request; throws for a request that isn't valid. */
  readonly input: (request: RelayControlRequest) => unknown
}

export type ControlOperations = Partial<
  Record<RelayControlOperation, ControlOperation>
>

/** A request's operation, with how its input comes from the request. */
export const controlOperation = <Input, A, E>(
  definition: RelayOperation<Input, A, E, never>,
  input: (request: RelayControlRequest) => Input
): ControlOperation => ({
  // It only ever sees the input `input` gives it.
  definition: definition as unknown as ControlOperation["definition"],
  input,
})
