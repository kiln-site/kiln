# syntax=docker/dockerfile:1.10

ARG VITE_PLUS_VERSION=0.2.5

FROM ghcr.io/voidzero-dev/vite-plus:${VITE_PLUS_VERSION} AS build

WORKDIR /source

# Keep dependency resolution independent from source and release metadata so
# ordinary application changes reuse the install layer.
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY --chown=vp:vp apps/web/package.json ./apps/web/package.json
COPY --chown=vp:vp packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=vp:vp packages/ui/package.json ./packages/ui/package.json
COPY --chown=vp:vp patches ./patches
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --frozen-lockfile --ignore-scripts --filter web...

COPY --chown=vp:vp tsconfig.json vite.config.ts release.json ./
COPY --chown=vp:vp apps/web ./apps/web
COPY --chown=vp:vp packages/contracts ./packages/contracts
COPY --chown=vp:vp packages/ui ./packages/ui

ARG SOURCE_COMMIT
ARG KILN_VERSION
ARG SENTRY_SOURCEMAPS
ARG VITE_SENTRY_DSN=https://9516d942af12672a1ff5aa7f181f7217@o4511745768226816.ingest.us.sentry.io/4511745775501312
ARG VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE=0.05
ARG VITE_SENTRY_TRACES_SAMPLE_RATE=0.05
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENV KILN_VERSION=$KILN_VERSION
ENV SENTRY_SOURCEMAPS=$SENTRY_SOURCEMAPS
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE=$VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE
ENV VITE_SENTRY_TRACES_SAMPLE_RATE=$VITE_SENTRY_TRACES_SAMPLE_RATE
RUN vp run web#build

FROM build AS runtime-build
RUN find apps/web/dist -type f -name '*.map' -delete

FROM scratch AS sentry-source-maps
COPY --from=build /source/apps/web/dist /

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
ENV PORT=3000
ENV SENTRY_DSN=https://9516d942af12672a1ff5aa7f181f7217@o4511745768226816.ingest.us.sentry.io/4511745775501312
ENV SENTRY_TRACES_SAMPLE_RATE=0.05
WORKDIR /app

# Keep the legacy source label until older Relays have received the
# repository-rename compatibility check.
LABEL org.opencontainers.image.source="https://github.com/kiln-site/hearth" \
  org.opencontainers.image.version="${KILN_VERSION}" \
  org.opencontainers.image.revision="${SOURCE_COMMIT}" \
  io.kiln.component="hearth"

COPY --from=runtime-deps --chown=65532:65532 /runtime/node_modules ./node_modules
COPY --from=runtime-build --chown=65532:65532 /source/apps/web/dist ./dist
COPY --from=runtime-build --chown=65532:65532 /source/apps/web/migrations ./migrations
COPY --from=runtime-build --chown=65532:65532 \
  /source/apps/web/scripts/database-config.mjs \
  /source/apps/web/scripts/legacy-access-permissions.mjs \
  /source/apps/web/scripts/migrate-access.mjs \
  /source/apps/web/scripts/migrate-app.mjs \
  /source/apps/web/scripts/serve.mjs \
  /source/apps/web/scripts/start-container.mjs \
  ./scripts/
COPY --from=runtime-build --chown=65532:65532 /source/apps/web/keyring.mjs ./keyring.mjs
COPY --from=runtime-build --chown=65532:65532 /source/apps/web/dist/instrument/instrument.server.mjs ./instrument.server.mjs
COPY --from=runtime-build --chown=65532:65532 /source/apps/web/package.runtime.json ./package.json

USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/health', { signal: AbortSignal.timeout(2500) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["scripts/start-container.mjs"]
