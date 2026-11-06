import { describe, expect, it } from "vite-plus/test"

import {
  emptySecuritySummary,
  groupSecurityFindings,
  securityVerdict,
  type SecurityFindingSummary,
  type SecuritySummary,
} from "@/lib/security"

const found = (
  counts: Partial<SecuritySummary["counts"]>,
  { fixableCritical = 0, knownExploited = 0 } = {}
): SecuritySummary => ({
  ...emptySecuritySummary(),
  counts: { ...emptySecuritySummary().counts, ...counts },
  fixableCritical,
  knownExploited,
})

describe("securityVerdict", () => {
  it("calls anything exploited unsafe, however little else, fix or not", () => {
    expect(securityVerdict(found({}, { knownExploited: 1 }))).toBe("unsafe")
    expect(securityVerdict(found({ low: 1 }, { knownExploited: 1 }))).toBe(
      "unsafe"
    )
  })

  it("calls a critical one unsafe once it has a fix, and risky until then", () => {
    expect(
      securityVerdict(found({ critical: 2 }, { fixableCritical: 1 }))
    ).toBe("unsafe")
    expect(securityVerdict(found({ critical: 2 }))).toBe("risky")
  })

  it("calls high ones risky, and leaves the rest minor", () => {
    expect(securityVerdict(found({ high: 1, medium: 90 }))).toBe("risky")
    expect(securityVerdict(found({ medium: 90 }))).toBe("minor")
    expect(securityVerdict(found({ negligible: 1 }))).toBe("minor")
  })

  it("calls an image with nothing found clean", () => {
    expect(securityVerdict(found({}))).toBe("clean")
  })
})

describe("groupSecurityFindings", () => {
  const finding = (
    vulnerabilityId: string,
    packageName: string,
    overrides: Partial<SecurityFindingSummary> = {}
  ): SecurityFindingSummary => ({
    firstSeenAt: 1,
    fixState: "fixed",
    fixedVersion: "1.0.1",
    installedVersions: ["1.0.0"],
    knownExploited: false,
    packageName,
    packageType: "deb",
    severity: "high",
    url: null,
    vulnerabilityId,
    ...overrides,
  })

  it("adds up one package's vulnerabilities", () => {
    const [openssl] = groupSecurityFindings(
      [
        finding("CVE-1", "openssl", { severity: "critical" }),
        finding("CVE-2", "openssl", {
          fixState: "not-fixed",
          fixedVersion: null,
        }),
      ],
      10
    )
    expect(openssl).toMatchObject({
      fixable: 1,
      fixedVersions: ["1.0.1"],
      name: "openssl",
      total: 2,
      worst: "critical",
    })
    expect(openssl?.counts).toMatchObject({ critical: 1, high: 1 })
  })

  it("keeps each fix it was offered, the most urgent's first", () => {
    const [nginx] = groupSecurityFindings(
      [
        finding("CVE-1", "nginx", { fixedVersion: "1.21.6" }),
        finding("CVE-2", "nginx", { fixedVersion: "1.9.9" }),
        finding("CVE-3", "nginx", { fixedVersion: "1.21.6" }),
      ],
      10
    )
    expect(nginx?.fixedVersions).toEqual(["1.21.6", "1.9.9"])
  })

  it("leads with what's exploited, whatever its severity", () => {
    expect(
      groupSecurityFindings(
        [
          finding("CVE-1", "critical-one", { severity: "critical" }),
          finding("CVE-2", "exploited-one", {
            knownExploited: true,
            severity: "low",
          }),
        ],
        10
      ).map(({ name }) => name)
    ).toEqual(["exploited-one", "critical-one"])
  })

  it("counts them all while listing only so many", () => {
    const [found] = groupSecurityFindings(
      [finding("CVE-1", "a"), finding("CVE-2", "a"), finding("CVE-3", "a")],
      2
    )
    expect(found?.total).toBe(3)
    expect(found?.vulnerabilities).toHaveLength(2)
  })
})
