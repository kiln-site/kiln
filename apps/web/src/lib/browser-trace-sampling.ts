// Hearth keeps a browser trace by its ID, so every batch of one trace gets
// the same decision. The browser makes it too, to tell a Relay whether the
// work it does for that trace is kept.
export function keepBrowserTrace(traceId: string, ratio: number): boolean {
  return Number.parseInt(traceId.slice(0, 8), 16) / 0x1_0000_0000 < ratio
}

/** The page's `<meta>` carrying the ratio, from the root route. */
export const browserTraceSampleRatioMeta = "kiln-browser-trace-sample-ratio"
