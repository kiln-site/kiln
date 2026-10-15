import { describe, it } from "vite-plus/test"
import { RuleTester } from "vite-plus/lint/plugins-dev"

import plugin from "./oxlint-plugin.mjs"

RuleTester.describe = describe
RuleTester.it = it

// Guards the CI rule itself: if a Vite+/Oxlint upgrade stops it reporting,
// raw recovery would slip into production code unnoticed.
new RuleTester().run(
  "kiln/effect-recovery",
  plugin.rules["effect-recovery"],
  {
    valid: [
      "pending.then(onFulfilled)",
      "Effect.catch(onRejected)",
      "Stream.catch(onRejected)",
    ],
    invalid: [
      {
        code: "try { run() } catch { recover() }",
        errors: [{ messageId: "tryStatement" }],
      },
      {
        code: "pending.catch(onRejected)",
        errors: [{ messageId: "promiseCatch" }],
      },
      {
        code: "pending.finally(cleanup)",
        errors: [{ messageId: "promiseFinally" }],
      },
      {
        code: "pending.then(onFulfilled, onRejected)",
        errors: [{ messageId: "promiseThen" }],
      },
    ],
  }
)
