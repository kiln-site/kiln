# syntax=docker/dockerfile:1.10

ARG VITE_PLUS_VERSION=1.0.0

FROM ghcr.io/voidzero-dev/vite-plus:${VITE_PLUS_VERSION} AS build

WORKDIR /source

# Install from manifests only, so ordinary content changes reuse this layer.
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY --chown=vp:vp apps/docs/package.json ./apps/docs/package.json
COPY --chown=vp:vp packages/ui/package.json ./packages/ui/package.json
COPY --chown=vp:vp patches ./patches
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --frozen-lockfile --ignore-scripts --filter docs...

COPY --chown=vp:vp tsconfig.json vite.config.ts ./
COPY --chown=vp:vp apps/docs ./apps/docs
COPY --chown=vp:vp packages/ui ./packages/ui

# The path the docs live under on the site. Every route and asset is built
# below it, so it's fixed when the image builds.
ARG KILN_DOCS_BASE_PATH=/docs
ENV KILN_DOCS_BASE_PATH=${KILN_DOCS_BASE_PATH}
RUN vp run docs#build \
  && find apps/docs/dist -type f -name '*.map' -delete

FROM ghcr.io/voidzero-dev/vite-plus:${VITE_PLUS_VERSION} AS runtime-deps

WORKDIR /runtime
COPY --chown=vp:vp .node-version ./
COPY --chown=vp:vp apps/docs/package.runtime.json ./package.json
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --prod --no-lockfile --no-optional --ignore-scripts

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime

ARG SOURCE_COMMIT
ARG KILN_DOCS_BASE_PATH=/docs
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV KILN_DOCS_BASE_PATH=${KILN_DOCS_BASE_PATH}
WORKDIR /app

ARG KILN_IMAGE_SOURCE=https://github.com/kiln-site/kiln
LABEL org.opencontainers.image.source="${KILN_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${SOURCE_COMMIT}" \
  io.kiln.component="docs"

COPY --from=runtime-deps --chown=65532:65532 /runtime/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /source/apps/docs/dist ./dist
COPY --from=build --chown=65532:65532 /source/apps/docs/scripts/serve.mjs /source/apps/docs/scripts/redirects.mjs ./scripts/
COPY --from=build --chown=65532:65532 /source/apps/docs/package.runtime.json ./package.json

USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + (process.env.KILN_DOCS_BASE_PATH || '/docs').replace(/\\/+$/, '') + '/', { signal: AbortSignal.timeout(2500) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["scripts/serve.mjs"]
