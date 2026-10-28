# syntax=docker/dockerfile:1.10

ARG VITE_PLUS_VERSION=1.0.0

FROM ghcr.io/voidzero-dev/vite-plus:${VITE_PLUS_VERSION} AS build

WORKDIR /source

# Keep dependency resolution independent from source and release metadata so
# ordinary application changes reuse the install layer.
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY --chown=vp:vp apps/web/package.json ./apps/web/package.json
COPY --chown=vp:vp packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=vp:vp packages/operations/package.json ./packages/operations/package.json
COPY --chown=vp:vp packages/telemetry/package.json ./packages/telemetry/package.json
COPY --chown=vp:vp packages/ui/package.json ./packages/ui/package.json
COPY --chown=vp:vp patches ./patches
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --frozen-lockfile --ignore-scripts --filter web...

COPY --chown=vp:vp tsconfig.json vite.config.ts release.json ./
COPY --chown=vp:vp apps/web ./apps/web
COPY --chown=vp:vp packages/contracts ./packages/contracts
COPY --chown=vp:vp packages/operations ./packages/operations
COPY --chown=vp:vp packages/telemetry ./packages/telemetry
COPY --chown=vp:vp packages/ui ./packages/ui

ARG SOURCE_COMMIT
ARG KILN_VERSION
# Telemetry defaults are baked into the server bundle, not the image
# environment: the Relay updater carries a container's environment into its
# replacement, so image ENV values would outlive the release that set them.
ARG OTEL_EXPORTER_OTLP_ENDPOINT
ARG OTEL_EXPORTER_OTLP_HEADERS
ARG OTEL_LOGS_EXPORTER
ARG OTEL_METRICS_EXPORTER
ARG OTEL_RESOURCE_ATTRIBUTES
ARG OTEL_TRACES_EXPORTER
ARG OTEL_TRACES_SAMPLER_ARG
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENV KILN_VERSION=$KILN_VERSION
RUN vp run web#build

FROM build AS runtime-build
# An empty directory for Hearth's data, which this non-root stage can create.
RUN find apps/web/dist -type f -name '*.map' -delete \
  && mkdir -p kiln-data

# Grype checks the inventories Relays send against known vulnerabilities.
FROM ghcr.io/anchore/grype:v0.121.0@sha256:621d56d1d68106b787022c81546f7e0a36202a25d1239f0c20195fab8c16f7ea AS grype

FROM ghcr.io/voidzero-dev/vite-plus:${VITE_PLUS_VERSION} AS runtime-deps

WORKDIR /runtime
COPY --chown=vp:vp .node-version ./
COPY --chown=vp:vp apps/web/package.runtime.json ./package.json
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --prod --no-lockfile --no-optional --ignore-scripts

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime

ARG KILN_GIT_REPO=https://github.com/kiln-site/kiln
ARG KILN_VERSION
ARG SOURCE_COMMIT
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV KILN_GIT_REPO=$KILN_GIT_REPO
ENV KILN_DEFAULT_GIT_REPO=$KILN_GIT_REPO
ENV PORT=3000
# Grype's vulnerability database, about 3 GB; mount a volume here to keep it
# across restarts instead of downloading it again.
ENV KILN_VULNERABILITY_DB_DIR=/var/lib/kiln/vulnerability-db
WORKDIR /app

# Keep the legacy source label until older Relays have received the
# repository-rename compatibility check.
ARG KILN_IMAGE_SOURCE=https://github.com/kiln-site/hearth
LABEL org.opencontainers.image.source="${KILN_IMAGE_SOURCE}" \
  org.opencontainers.image.version="${KILN_VERSION}" \
  org.opencontainers.image.revision="${SOURCE_COMMIT}" \
  io.kiln.component="hearth"

COPY --from=grype /grype /usr/local/bin/grype
COPY --from=runtime-build --chown=65532:65532 /source/kiln-data /var/lib/kiln
COPY --from=runtime-deps --chown=65532:65532 /runtime/node_modules ./node_modules
COPY --from=runtime-build --chown=65532:65532 /source/apps/web/dist ./dist
COPY --from=runtime-build --chown=65532:65532 \
  /source/apps/web/scripts/serve.mjs \
  /source/apps/web/scripts/start-container.mjs \
  ./scripts/
COPY --from=runtime-build --chown=65532:65532 /source/apps/web/keyring.mjs ./keyring.mjs
COPY --from=runtime-build --chown=65532:65532 /source/apps/web/package.runtime.json ./package.json

USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/health', { signal: AbortSignal.timeout(2500) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["scripts/start-container.mjs"]
