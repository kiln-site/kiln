import { definePlugin, defineRule } from "vite-plus/lint/plugins"

const staticEffectNamespaces = new Set(["Effect", "Result", "Schema", "Stream"])

const effectRecovery = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Recover errors with Effect/Result instead of try statements or Promise rejection handlers.",
    },
    messages: {
      tryStatement:
        "Use Effect.try, Effect.tryPromise, or Result.try instead of a raw try statement.",
      promiseCatch:
        "Use Effect.catch or the promise.ts helpers (recoverPromise, forkPromise) instead of Promise .catch().",
      promiseFinally:
        "Use Effect.ensuring or ensuringPromise from promise.ts instead of Promise .finally().",
      promiseThen:
        "Use Effect.match or settlePromises from promise.ts instead of .then(_, onRejected).",
    },
  },
  create(context) {
    return {
      TryStatement(node) {
        context.report({ node, messageId: "tryStatement" })
      },
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier"
        )
          return
        const method = callee.property.name
        if (method === "catch") {
          const isStaticEffectOperator =
            callee.object.type === "Identifier" &&
            staticEffectNamespaces.has(callee.object.name)
          if (!isStaticEffectOperator)
            context.report({ node, messageId: "promiseCatch" })
        } else if (method === "finally") {
          context.report({ node, messageId: "promiseFinally" })
        } else if (method === "then" && node.arguments.length >= 2) {
          context.report({ node, messageId: "promiseThen" })
        }
      },
    }
  },
})

export default definePlugin({
  meta: { name: "kiln" },
  rules: { "effect-recovery": effectRecovery },
})
