# syntax=docker/dockerfile:1.10

ARG VITE_PLUS_VERSION=1.0.0

FROM ghcr.io/voidzero-dev/vite-plus:${VITE_PLUS_VERSION} AS build

WORKDIR /source

# The site's demos render Hearth's components from apps/web/src, which resolve
# their packages from apps/web, so Hearth's dependencies install too. Keep this
# independent from source so ordinary changes reuse the install layer.
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY --chown=vp:vp apps/marketing/package.json ./apps/marketing/package.json
COPY --chown=vp:vp apps/web/package.json ./apps/web/package.json
COPY --chown=vp:vp packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=vp:vp packages/telemetry/package.json ./packages/telemetry/package.json
COPY --chown=vp:vp packages/ui/package.json ./packages/ui/package.json
COPY --chown=vp:vp patches ./patches
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --frozen-lockfile --ignore-scripts --filter marketing... --filter web...

COPY --chown=vp:vp tsconfig.json vite.config.ts release.json ./
COPY --chown=vp:vp apps/marketing ./apps/marketing
COPY --chown=vp:vp apps/web ./apps/web
COPY --chown=vp:vp apps/bricks/icons ./apps/bricks/icons
COPY --chown=vp:vp packages/contracts ./packages/contracts
COPY --chown=vp:vp packages/telemetry ./packages/telemetry
COPY --chown=vp:vp packages/ui ./packages/ui

RUN vp run marketing#build \
  && find apps/marketing/dist -type f -name '*.map' -delete

FROM ghcr.io/voidzero-dev/vite-plus:${VITE_PLUS_VERSION} AS runtime-deps

WORKDIR /runtime
COPY --chown=vp:vp .node-version ./
COPY --chown=vp:vp apps/marketing/package.runtime.json ./package.json
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --prod --no-lockfile --no-optional --ignore-scripts

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime

ARG SOURCE_COMMIT
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

ARG KILN_IMAGE_SOURCE=https://github.com/kiln-site/kiln
LABEL org.opencontainers.image.source="${KILN_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${SOURCE_COMMIT}" \
  io.kiln.component="marketing"

COPY --from=runtime-deps --chown=65532:65532 /runtime/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /source/apps/marketing/dist ./dist
COPY --from=build --chown=65532:65532 /source/apps/marketing/scripts/serve.mjs ./scripts/serve.mjs
COPY --from=build --chown=65532:65532 /source/apps/marketing/package.runtime.json ./package.json

USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/', { signal: AbortSignal.timeout(2500) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["scripts/serve.mjs"]
