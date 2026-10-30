import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { layer } from "./index.js"

// Counts trace exports a collector receives while `program` runs and the
// telemetry layer shuts down, flushing what it kept.
const exportedTraces = (ratio: string) =>
  Effect.gen(function* () {
    let traces = 0
    const server = createServer((request, response) => {
      if (request.url === "/v1/traces") traces += 1
      request.resume()
      request.on("end", () => response.writeHead(200).end())
    })
    yield* Effect.acquireRelease(
      Effect.promise(
        () => new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
      ),
      () =>
        Effect.promise(
          () => new Promise<void>((done) => server.close(() => done()))
        )
    )
    const { port } = server.address() as AddressInfo
    yield* Effect.void.pipe(
      Effect.withSpan("parentless"),
      Effect.provide(
        layer(
          { serviceName: "telemetry-test" },
          {
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
            OTEL_TRACES_SAMPLER_ARG: ratio,
            OTEL_LOGS_EXPORTER: "none",
            OTEL_METRICS_EXPORTER: "none",
          }
        )
      )
    )
    return traces
  })

// A span with no parent starts a trace, so the sample ratio applies to it.
it.live("samples traces started by spans without a parent", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* exportedTraces("0"), 0)
    assert.isAbove(yield* exportedTraces("1"), 0)
  }).pipe(Effect.scoped)
)
