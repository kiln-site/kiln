import { defineConfig } from "vite-plus"

export default defineConfig({
  check: {
    // Oxfmt intentionally remains available, but formatting is not enforced
    // repository-wide so this build-only migration does not rewrite app code.
    fmt: false,
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
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
    options: { typeAware: true, typeCheck: false },
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
