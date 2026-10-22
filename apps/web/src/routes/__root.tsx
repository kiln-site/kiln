import { Outlet, createRootRouteWithContext } from "@tanstack/react-router"
import { geistLatin, jetBrainsMonoLatin } from "@workspace/ui/lib/font-assets"

import appCss from "@workspace/ui/globals.css?url"

import appIcon192 from "@/assets/branding/app-icon-192.png?no-inline"
import faviconSvg from "@/assets/branding/favicon.svg?no-inline"

import { AppErrorPage, AppNotFoundPage } from "@/components/app-error-page"
import { browserTraceSampleRatioMeta } from "@/lib/browser-trace-sampling"
import type { AppRouterContext } from "@/lib/query-client"
import { getPublicRuntimeConfig } from "@/server/runtime-config"

export const Route = createRootRouteWithContext<AppRouterContext>()({
  loader: () => getPublicRuntimeConfig(),
  staleTime: Infinity,
  head: ({ loaderData }) => ({
    meta: [
      {
        charSet: "utf-8",
      },
      ...(loaderData?.browserTraceSampleRatio == null
        ? []
        : [
            {
              name: browserTraceSampleRatioMeta,
              content: String(loaderData.browserTraceSampleRatio),
            },
          ]),
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Kiln",
      },
      {
        // The label under the Home Screen icon on iPhone and iPad.
        name: "apple-mobile-web-app-title",
        content: "Kiln",
      },
      {
        name: "description",
        content:
          "Deploy and operate reproducible game server instances with Kiln.",
      },
    ],
    links: [
      {
        rel: "preload",
        href: geistLatin,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: jetBrainsMonoLatin,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "icon",
        href: faviconSvg,
        type: "image/svg+xml",
        sizes: "any",
      },
      {
        rel: "icon",
        href: "/favicon.ico",
        sizes: "16x16 32x32 48x48",
      },
      {
        rel: "apple-touch-icon",
        href: appIcon192,
        sizes: "192x192",
      },
      {
        rel: "manifest",
        href: "/manifest.json",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  component: Outlet,
  errorComponent: AppErrorPage,
  notFoundComponent: AppNotFoundPage,
})
