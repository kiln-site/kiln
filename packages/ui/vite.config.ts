import { defineConfig } from "vite-plus"

export default defineConfig({
  run: {
    tasks: {
      typecheck: "node ../../scripts/typecheck.mjs",
    },
  },
})
