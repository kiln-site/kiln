import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_KILN_GIT_REPO,
  LEGACY_KILN_GIT_REPO,
  isKilnGitRepositorySource,
  kilnImageSource,
} from "../packages/contracts/src/git-repository.ts"

test("official releases retain the source label required by older Relays", () => {
  assert.equal(kilnImageSource(DEFAULT_KILN_GIT_REPO), LEGACY_KILN_GIT_REPO)
  assert.ok(
    isKilnGitRepositorySource(LEGACY_KILN_GIT_REPO, DEFAULT_KILN_GIT_REPO)
  )
})

test("a fork accepts its own provenance but never upstream's legacy label", () => {
  const fork = "https://github.com/example/fork"
  assert.equal(kilnImageSource(fork), fork)
  assert.ok(isKilnGitRepositorySource(fork, fork))
  assert.equal(isKilnGitRepositorySource(LEGACY_KILN_GIT_REPO, fork), false)
  assert.equal(isKilnGitRepositorySource(DEFAULT_KILN_GIT_REPO, fork), false)
})
