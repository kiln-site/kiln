import { createServerFn } from "@tanstack/react-start"

export const getPublicRuntimeConfig = createServerFn({ method: "GET" }).handler(
  async () => {
    const [{ kilnGitRepository, kilnLegalUrls }, { otlpTarget }, { Effect, Option }] =
      await Promise.all([
        import("@/lib/environment"),
        import("@workspace/telemetry"),
        import("effect"),
      ])
    const [{ telemetryDefaults }, { browserTraceSampleRatio }] =
      await Promise.all([
        import("@/effect/runtime"),
        import("@/server/browser-telemetry"),
      ])
    const traces = await Effect.runPromise(
      otlpTarget("traces", telemetryDefaults)
    )
    return {
      // Null when Hearth forwards no browser traces.
      browserTraceSampleRatio: Option.match(traces, {
        onNone: () => null,
        onSome: browserTraceSampleRatio,
      }),
      gitRepository: kilnGitRepository(),
      legalUrls: kilnLegalUrls(),
    }
  }
)
