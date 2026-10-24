import { defineConfig } from "vite-plus"

export default defineConfig({
  run: {
    tasks: {
      typecheck: {
        command: "node ../../scripts/typecheck.mjs",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
    },
  },
})
