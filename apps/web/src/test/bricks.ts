import { brickSchema } from "@workspace/contracts"

export const testBrickSource = "https://bricks.test/paper.yml"

/** A game server's Brick, for tests that need one to stand in. */
export const testBrick = brickSchema.parse({
  format: "kiln.brick/v2",
  kind: "game-server",
  metadata: {
    id: "paper",
    name: "Paper",
    summary: "A test game server.",
    author: "Kiln",
    tags: [],
  },
  inputs: [],
  deploy: {
    type: "image",
    image: "example.test/paper:latest",
    runtime: "Paper",
    memory: "64m",
    pids: 128,
    volumes: ["/server"],
    ports: [{ name: "game", port: 25_565 }],
  },
  "game-server": { game: "Minecraft" },
  source: testBrickSource,
})
