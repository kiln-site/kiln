import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vite-plus/test"

import { UsageBar } from "@/components/usage-bar"

it.each([
  { used: 106, total: 200, fill: 53 },
  { used: 200, total: 400, fill: 50 },
  { used: 100, total: 100, fill: 100 },
  { used: 240, total: 200, fill: 100 },
  { used: 0, total: 200, fill: 0 },
  { used: 106, total: 0, fill: 0 },
  { used: undefined, total: undefined, fill: 0 },
])(
  "scales CPU $used against capacity $total to a $fill% fill",
  ({ used, total, fill }) => {
    const markup = renderToStaticMarkup(
      <UsageBar
        indicatorClassName=""
        label="CPU"
        used={used}
        total={total}
        value={used === undefined ? "—" : `${used}%`}
      />
    )

    expect(markup).toContain(`aria-valuenow="${fill}"`)
    expect(markup).toContain(`translateX(-${100 - fill}%)`)
    if (used !== undefined) expect(markup).toContain(`${used}%`)
  }
)
