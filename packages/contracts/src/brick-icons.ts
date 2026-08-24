const MAX_BRICK_ICON_BYTES = 64 * 1024

const FORBIDDEN_SVG_CONTENT =
  /<(?:script|foreignObject|image|iframe|object|embed|audio|video|style|link|animate|animateMotion|animateTransform|set)\b|\b(?:href|xlink:href|on[a-z]+)\s*=|url\s*\(|<!DOCTYPE|<\?xml/iu

const SVG_ROOT = /^\s*<svg\b([^>]*)>[\s\S]*<\/svg>\s*$/iu
const VIEW_BOX =
  /\bviewBox\s*=\s*["']\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s+(-?(?:\d+(?:\.\d+)?|\.\d+))\s+((?:\d+(?:\.\d+)?|\.\d+))\s+((?:\d+(?:\.\d+)?|\.\d+))\s*["']/iu

export function validateBrickIconSvg(input: string): string {
  const svg = input.trim()
  if (!svg) throw new Error("Brick icon SVG is empty")
  if (new TextEncoder().encode(svg).byteLength > MAX_BRICK_ICON_BYTES) {
    throw new Error("Brick icon SVG exceeds 64 KiB")
  }
  if (FORBIDDEN_SVG_CONTENT.test(svg)) {
    throw new Error("Brick icon SVG contains unsupported active content")
  }
  const root = SVG_ROOT.exec(svg)
  if (!root?.[1]) throw new Error("Brick icon must be an SVG document")
  const viewBox = VIEW_BOX.exec(root[1])
  if (!viewBox?.[3] || !viewBox[4]) {
    throw new Error("Brick icon SVG must declare a viewBox")
  }
  const width = Number(viewBox[3])
  const height = Number(viewBox[4])
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    Math.abs(width - height) > Number.EPSILON
  ) {
    throw new Error("Brick icon SVG viewBox must be square")
  }
  return svg
}
