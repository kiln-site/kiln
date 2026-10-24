import { defineConfig } from "vite-plus"

export default defineConfig({
  run: {
    tasks: {
      typecheck: "tsrs --noEmit --checkers 2",
    },
  },
})
