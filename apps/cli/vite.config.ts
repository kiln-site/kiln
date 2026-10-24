import { defineConfig } from "vite-plus"

export default defineConfig({
  run: {
    tasks: {
      typecheck: {
        command: "tsrs --noEmit --checkers 2",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
    },
  },
})
