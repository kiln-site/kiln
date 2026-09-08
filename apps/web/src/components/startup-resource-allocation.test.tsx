import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vite-plus/test"
import { ResourceAllocationCard } from "@/components/startup-resource-allocation"

describe("Startup resource allocation visibility", () => {
  it("keeps the server's inputs usable without rendering host capacity or a false maximum", () => {
    const html = renderToStaticMarkup(
      <ResourceAllocationCard
        allocation={null}
        configuredMemoryBytes={2 * 1024 ** 3}
        diskLimitGiB="10"
        disabled={false}
        memoryValue="2G"
        onDiskLimitChange={() => undefined}
        onMemoryChange={() => undefined}
      />
    )
    expect(html).toContain('aria-label="Memory limit"')
    expect(html).toContain('value="2G"')
    expect(html).toContain('aria-label="Disk quota in GiB"')
    expect(html).toContain('value="10"')
    expect(html).not.toContain(" max=")
    expect(html).not.toContain("disabled=")
    expect(html).not.toContain("assignable")
    expect(html).not.toContain("node used")
    expect(html).not.toContain("0 B")
  })
})
