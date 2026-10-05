import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import {
  kilnImagePrefix,
  kilnImageRepository,
  kilnImageSource,
  kilnGitRepositorySlug,
  resolveKilnGitRepository,
} from "../packages/contracts/src/git-repository.ts"
import {
  isKilnReleaseVersion,
  compareKilnReleaseVersions,
} from "../packages/contracts/src/release-version.ts"

const execFileAsync = promisify(execFile)
const runAsync = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

const run = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim()
const output = (name, value) => {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

export function validateNextReleaseLine(version, nextReleaseLine) {
  if (
    typeof nextReleaseLine !== "string" ||
    !stableVersionPattern.test(nextReleaseLine) ||
    compareKilnReleaseVersions(nextReleaseLine, version) !== 1
  )
    throw new Error(
      "The next release must be a major.minor.patch version newer than the promoted release"
    )
  return nextReleaseLine
}

export function resolveReleaseLine(initialLine, latestStable) {
  if (latestStable?.nextReleaseLine !== undefined) {
    return validateNextReleaseLine(
      latestStable.version,
      latestStable.nextReleaseLine
    )
  }
  const initial = initialLine?.trim() || "0.1.0"
  if (!stableVersionPattern.test(initial))
    throw new Error("INITIAL_RELEASE_LINE must be major.minor.patch")
  if (!latestStable) return initial
  // Bootstrap repositories whose existing stable manifests predate this field.
  if (!stableVersionPattern.test(latestStable.version))
    throw new Error("Invalid stable release version")
  if (compareKilnReleaseVersions(initial, latestStable.version) === 1)
    return initial
  const [major, minor, patch] = latestStable.version.split(".").map(Number)
  return `${major}.${minor}.${patch + 1}`
}

export function releaseConfiguration(environment, timestamp, latestStable) {
  const repository = resolveKilnGitRepository(
    environment.GITHUB_REPOSITORY || environment.KILN_GIT_REPO
  )
  const line = resolveReleaseLine(
    environment.KILN_INITIAL_RELEASE_LINE,
    latestStable
  )
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime()))
    throw new Error("Invalid source commit timestamp")
  const stamp = date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace("T", ".")
    .slice(0, 15)
  return {
    repository,
    prefix: kilnImagePrefix(repository),
    source: kilnImageSource(repository),
    version: `${line}-nightly.${stamp}`,
  }
}

function githubRunConfigurationStore(environment) {
  const base = `repos/${kilnGitRepositorySlug(environment.GITHUB_REPOSITORY)}/git`
  const tag = `nightly-run/${environment.GITHUB_RUN_ID}`
  return {
    async read() {
      const ref = JSON.parse(
        await runAsync("gh", ["api", `${base}/ref/tags/${tag}`])
      )
      if (ref.object?.type !== "tag")
        throw new Error("Expected an annotated nightly run tag")
      const record = JSON.parse(
        await runAsync("gh", ["api", `${base}/tags/${ref.object.sha}`])
      )
      if (
        record.tag !== tag ||
        record.object?.type !== "commit" ||
        record.object.sha !== environment.GITHUB_SHA
      )
        throw new Error("Nightly run tag does not match this checkout")
      return JSON.parse(record.message)
    },
    async create(saved) {
      const record = JSON.parse(
        await runAsync("gh", [
          "api",
          `${base}/tags`,
          "--method",
          "POST",
          "-f",
          `tag=${tag}`,
          "-f",
          `object=${saved.commit}`,
          "-f",
          "type=commit",
          "-f",
          `message=${JSON.stringify(saved)}`,
        ])
      )
      // Create only: never update/force an existing run's configuration.
      await runAsync("gh", [
        "api",
        `${base}/refs`,
        "--method",
        "POST",
        "-f",
        `ref=refs/tags/${tag}`,
        "-f",
        `sha=${record.sha}`,
      ])
    },
  }
}

export async function workflowReleaseConfiguration(
  environment,
  timestamp,
  loadLatestStable = latestStableManifest,
  store = githubRunConfigurationStore(environment)
) {
  if (environment.KILN_RESOLVE_RELEASE_LINE !== "true")
    return releaseConfiguration(environment, timestamp)

  const runId = environment.GITHUB_RUN_ID
  const commit = environment.GITHUB_SHA
  if (!/^\d+$/u.test(runId ?? "") || !/^[a-f0-9]{40}$/u.test(commit ?? ""))
    throw new Error("Nightly configuration requires a run ID and commit")

  if (environment.GITHUB_RUN_ATTEMPT !== "1") {
    // Never consult today's release line when retrying an older checkout.
    let saved
    try {
      saved = await store.read()
    } catch (cause) {
      throw new Error(
        "Cannot load the original nightly release configuration. Check access to the nightly-run tag; if it is missing, start a new Nightly release run from main.",
        { cause }
      )
    }
    if (
      saved?.runId !== runId ||
      saved.commit !== commit ||
      !isKilnReleaseVersion(saved.config?.version) ||
      !saved.config.version.includes("-nightly.")
    )
      throw new Error("Saved nightly configuration does not match this run")
    const expected = releaseConfiguration(
      {
        ...environment,
        KILN_INITIAL_RELEASE_LINE: saved.config.version.split("-nightly.")[0],
      },
      timestamp
    )
    if (
      Object.entries(expected).some(
        ([key, value]) => saved.config[key] !== value
      )
    )
      throw new Error(
        "Saved nightly configuration does not match this checkout"
      )
    return expected
  }

  const config = releaseConfiguration(
    environment,
    timestamp,
    await loadLatestStable()
  )
  await store.create({ runId, commit, config })
  return config
}

export function validateReleaseManifest(manifest, repository, version) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !isKilnReleaseVersion(version) ||
    manifest.channel !==
      (version.includes("-nightly.") ? "nightly" : "stable") ||
    manifest.version !== version ||
    manifest.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/u.test(manifest.commit) ||
    !Number.isInteger(manifest.compatibility?.relayProtocol)
  ) {
    throw new Error("Invalid release manifest")
  }
  if (
    Object.keys(manifest.components ?? {})
      .sort()
      .join(",") !== "hearth,relay"
  )
    throw new Error("Unexpected release manifest components")
  for (const component of ["hearth", "relay"]) {
    const image = manifest.components?.[component]
    if (
      image?.image !== kilnImageRepository(component, repository) ||
      !/^sha256:[a-f0-9]{64}$/u.test(image.digest)
    ) {
      throw new Error(`Unexpected ${component} image in release manifest`)
    }
  }
}

export function nightlyRollingTags(published, version) {
  if (
    published.some(
      (release) =>
        release.prerelease &&
        compareKilnReleaseVersions(release.tag_name.slice(1), version) > 0
    )
  )
    return []
  return published.some((release) => !release.prerelease)
    ? ["latest-nightly"]
    : ["latest-nightly", "latest"]
}

export function validateStablePromotion(published, nightlyVersion) {
  if (
    !isKilnReleaseVersion(nightlyVersion) ||
    !/-nightly\.\d{8}\.\d{6}$/u.test(nightlyVersion)
  )
    throw new Error("Invalid nightly version")
  const version = nightlyVersion.split("-nightly.")[0]
  const selected = published.find(
    (release) => release.tag_name === `v${nightlyVersion}`
  )
  if (!selected?.prerelease)
    throw new Error("Select an existing nightly release")
  if (
    published.some(
      (release) =>
        !release.prerelease &&
        compareKilnReleaseVersions(release.tag_name.slice(1), version) > 0
    )
  )
    throw new Error("A newer stable release already exists")
  if (
    published.some(
      (release) =>
        release.prerelease &&
        release.tag_name.startsWith(`v${version}-nightly.`) &&
        compareKilnReleaseVersions(release.tag_name.slice(1), nightlyVersion) >
          0
    )
  )
    throw new Error("Promote the newest nightly in this release line")
  return selected
}

async function latestStableManifest() {
  let latest
  try {
    latest = JSON.parse(
      await runAsync("gh", [
        "api",
        `repos/${process.env.GITHUB_REPOSITORY}/releases/latest`,
      ])
    )
  } catch (error) {
    // A new fork has no stable release yet. Authentication/network errors still fail.
    if (error.stderr?.toString().includes("(HTTP 404)")) return undefined
    throw error
  }
  if (latest.draft || latest.prerelease)
    throw new Error("Expected a published stable release")
  const manifest = JSON.parse(
    await runAsync("gh", [
      "release",
      "download",
      latest.tag_name,
      "--pattern",
      "release-manifest.json",
      "--output",
      "-",
    ])
  )
  validateReleaseManifest(
    manifest,
    resolveKilnGitRepository(process.env.GITHUB_REPOSITORY),
    latest.tag_name.slice(1)
  )
  return manifest
}

function releases() {
  return JSON.parse(
    run("gh", [
      "api",
      `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`,
      "--paginate",
      "--slurp",
    ])
  )
    .flat()
    .filter(
      (release) =>
        !release.draft && isKilnReleaseVersion(release.tag_name?.slice(1))
    )
}

function reserveTag(tag, commit) {
  const refs = run("git", ["tag", "--list", tag])
  if (refs) {
    if (run("git", ["rev-list", "-n", "1", tag]) !== commit)
      throw new Error(`${tag} already points to a different commit`)
  } else {
    run("git", ["tag", tag, commit])
    run("git", ["push", "origin", `refs/tags/${tag}`])
  }
}

function tagImage(reference, targets) {
  return runAsync("docker", [
    "buildx",
    "imagetools",
    "create",
    ...targets.flatMap((tag) => ["--tag", tag]),
    reference,
  ])
}

async function assertPublicManifest(image, digest) {
  const path = image.replace(/^ghcr\.io\//u, "")
  const tokenResponse = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${path}:pull`)}`
  )
  if (!tokenResponse.ok)
    throw new Error(
      `Make ${image} public in GHCR before publishing the release`
    )
  const { token } = await tokenResponse.json()
  const response = await fetch(
    `https://ghcr.io/v2/${path}/manifests/${digest}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
      },
    }
  )
  if (!response.ok)
    throw new Error(
      `Anonymous pull failed for ${image}; check GHCR package visibility`
    )
}

function publishRelease(manifest, existing, title, repository) {
  const tag = `v${manifest.version}`
  if (existing) {
    run("gh", [
      "release",
      "download",
      tag,
      "--pattern",
      "release-manifest.json",
      "--output",
      "existing-manifest.json",
    ])
    const previous = JSON.parse(readFileSync("existing-manifest.json", "utf8"))
    if (previous.nextReleaseLine !== manifest.nextReleaseLine) {
      throw new Error(
        "This stable release already records a different next release line; retry with the original next_release input"
      )
    }
    if (
      previous.commit !== manifest.commit ||
      JSON.stringify(previous.components) !==
        JSON.stringify(manifest.components)
    ) {
      throw new Error(
        "Refusing to rewrite an existing release with different images"
      )
    }
    // Preserve publication time and display aliases on retries.
    return
  }
  writeFileSync(
    "release-manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  writeFileSync(
    "distribution.env",
    `KILN_GIT_REPO=${repository}\nKILN_IMAGE_PREFIX=${kilnImagePrefix(repository)}\n`
  )
  run("gh", [
    "release",
    "create",
    tag,
    "release-manifest.json",
    "distribution.env",
    "--verify-tag",
    "--generate-notes",
    "--title",
    title,
    ...(manifest.channel === "nightly"
      ? ["--prerelease", "--latest=false"]
      : ["--latest"]),
  ])
}

async function nightly() {
  const repository = resolveKilnGitRepository(process.env.GITHUB_REPOSITORY)
  const version = process.env.KILN_VERSION
  if (!isKilnReleaseVersion(version) || !version.includes("-nightly."))
    throw new Error("Invalid nightly version")
  const tag = `v${version}`
  const commit = run("git", ["rev-parse", "HEAD"])
  const published = releases()
  const existing = published.find((release) => release.tag_name === tag)
  let manifest
  if (existing) {
    run("gh", [
      "release",
      "download",
      tag,
      "--pattern",
      "release-manifest.json",
      "--output",
      "release-manifest.json",
    ])
    manifest = JSON.parse(readFileSync("release-manifest.json", "utf8"))
    validateReleaseManifest(manifest, repository, version)
    if (manifest.commit !== commit)
      throw new Error("Release commit does not match checkout")
  } else {
    const components = {}
    await Promise.all(
      ["hearth", "relay"].map(async (component) => {
        const image = kilnImageRepository(component, repository)
        const sources = ["amd64", "arm64"].map((arch) => {
          const files = readdirSync(`/tmp/digests/digests-${component}-${arch}`)
          if (files.length !== 1 || !/^[a-f0-9]{64}$/u.test(files[0]))
            throw new Error(`Missing ${component}/${arch} digest`)
          return `${image}@sha256:${files[0]}`
        })
        await runAsync("docker", [
          "buildx",
          "imagetools",
          "create",
          "--tag",
          `${image}:${version}`,
          "--tag",
          `${image}:sha-${commit.slice(0, 7)}`,
          ...sources,
        ])
        // Do not trim the raw bytes: the registry digest covers the exact document.
        const raw = await runAsync("docker", [
          "buildx",
          "imagetools",
          "inspect",
          `${image}:${version}`,
          "--raw",
        ])
        const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`
        await assertPublicManifest(image, digest)
        components[component] = { image, digest }
      })
    )
    const protocol = Number(
      readFileSync("packages/contracts/src/relay-protocol.ts", "utf8").match(
        /relayControlProtocolVersion = (\d+)/u
      )?.[1]
    )
    manifest = {
      schemaVersion: 1,
      version,
      imageVersion: version,
      channel: "nightly",
      commit,
      publishedAt: new Date().toISOString(),
      components,
      compatibility: { relayProtocol: protocol },
    }
    validateReleaseManifest(manifest, repository, version)
    reserveTag(tag, commit)
    publishRelease(
      manifest,
      false,
      `v${version.split("-nightly.")[0]} Nightly #${process.env.GITHUB_RUN_NUMBER}`,
      repository
    )
  }
  const rollingTags = nightlyRollingTags(published, version)
  if (rollingTags.length > 0) {
    await Promise.all(
      Object.values(manifest.components).map(({ image, digest }) =>
        tagImage(
          `${image}@${digest}`,
          rollingTags.map((tag) => `${image}:${tag}`)
        )
      )
    )
  }
  output("tag", tag)
}

async function stable() {
  const nightlyVersion = process.env.NIGHTLY
  const published = releases()
  const selected = validateStablePromotion(published, nightlyVersion)
  const version = nightlyVersion.split("-nightly.")[0]
  const nextReleaseLine = validateNextReleaseLine(
    version,
    process.env.NEXT_RELEASE
  )
  const repository = resolveKilnGitRepository(process.env.GITHUB_REPOSITORY)
  run("gh", [
    "release",
    "download",
    selected.tag_name,
    "--pattern",
    "release-manifest.json",
    "--output",
    "release-manifest.json",
  ])
  const manifest = JSON.parse(readFileSync("release-manifest.json", "utf8"))
  validateReleaseManifest(manifest, repository, nightlyVersion)
  if (
    manifest.channel !== "nightly" ||
    run("git", ["rev-list", "-n", "1", selected.tag_name]) !== manifest.commit
  )
    throw new Error("Nightly tag and manifest disagree")
  await Promise.all(
    Object.values(manifest.components).map(({ image, digest }) =>
      assertPublicManifest(image, digest)
    )
  )
  const promoted = {
    ...manifest,
    version,
    channel: "stable",
    nextReleaseLine,
    publishedAt: new Date().toISOString(),
  }
  reserveTag(`v${version}`, manifest.commit)
  publishRelease(
    promoted,
    published.some((release) => release.tag_name === `v${version}`),
    `v${version}`,
    repository
  )
  await Promise.all(
    Object.values(manifest.components).map(({ image, digest }) =>
      tagImage(`${image}@${digest}`, [`${image}:${version}`, `${image}:latest`])
    )
  )
  output("tag", `v${version}`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  switch (process.argv[2]) {
    case "config": {
      const config = await workflowReleaseConfiguration(
        process.env,
        run("git", ["show", "-s", "--format=%cI", "HEAD"])
      )
      for (const [name, value] of Object.entries(config)) output(name, value)
      break
    }
    case "nightly":
      await nightly()
      break
    case "stable":
      await stable()
      break
    default:
      throw new Error("Expected config, nightly, or stable")
  }
}
