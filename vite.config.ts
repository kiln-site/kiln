import { defineConfig } from "vite-plus"

export default defineConfig({
  check: {
    // Oxfmt intentionally remains available, but formatting is not enforced
    // repository-wide so this build-only migration does not rewrite app code.
    fmt: false,
  },
  lint: {
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      "./scripts/oxlint-plugin.mjs",
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // Match the previous ESLint rule surface without rewriting application
      // code as part of this build-tool migration.
      "typescript/no-base-to-string": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-misused-spread": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "unicorn/no-new-array": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
    },
    overrides: [
      {
        // Production code recovers errors through Effect/Result so failures
        // keep their types, interruption, and telemetry.
        files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
        rules: { "kiln/effect-recovery": "error" },
      },
      {
        // `test/` holds shared test fakes and fixtures, not production code.
        files: [
          "**/*.{test,spec}.{ts,tsx}",
          "**/test/**",
          "**/instrument.ts",
        ],
        rules: { "kiln/effect-recovery": "off" },
      },
    ],
    // Only the unavailable-tsrs fallback enables compiler diagnostics here.
    // Ordinary `vp check` runs semantic lint rules without a second typecheck.
    options: {
      typeAware: true,
      typeCheck: process.env.KILN_TYPECHECK_FALLBACK === "1",
    },
  },
  test: {
    // Repository tooling tests; workspace packages run their own via `vp run -r test`.
    include: ["scripts/**/*.test.mjs"],
  },
  fmt: {
    endOfLine: "lf",
    semi: false,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "es5",
    printWidth: 80,
    sortPackageJson: false,
    sortTailwindcss: {
      stylesheet: "packages/ui/src/styles/globals.css",
      functions: ["cn", "cva"],
    },
    ignorePatterns: [
      "dist/",
      "node_modules/",
      ".output/",
      ".nitro/",
      ".tanstack/",
      ".vinxi/",
      "coverage/",
      "pnpm-lock.yaml",
      ".pnpm-store/",
    ],
  },
})
