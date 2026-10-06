# syntax=docker/dockerfile:1.10

ARG VITE_PLUS_VERSION=1.0.0

FROM ghcr.io/voidzero-dev/vite-plus:${VITE_PLUS_VERSION} AS runtime-deps

WORKDIR /runtime

COPY --chown=vp:vp .node-version ./
COPY --chown=vp:vp apps/relay/package.runtime.json ./package.json
COPY --chown=vp:vp apps/relay/pnpm-lock.runtime.yaml ./pnpm-lock.yaml
COPY --chown=vp:vp apps/relay/runtime.npmrc ./.npmrc
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --prod --frozen-lockfile --no-optional --ignore-scripts

FROM ghcr.io/voidzero-dev/vite-plus:${VITE_PLUS_VERSION} AS build

WORKDIR /source

COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY --chown=vp:vp apps/relay/package.json ./apps/relay/package.json
COPY --chown=vp:vp packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=vp:vp patches ./patches
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000,sharing=locked \
  vp install --frozen-lockfile --ignore-scripts --filter relay...

COPY --chown=vp:vp tsconfig.json vite.config.ts release.json ./
COPY --chown=vp:vp apps/relay ./apps/relay
COPY --chown=vp:vp packages/contracts ./packages/contracts

ARG SOURCE_COMMIT
ARG KILN_VERSION
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENV KILN_VERSION=$KILN_VERSION
RUN vp run relay#build

FROM docker:29.8.2-cli AS docker-cli

FROM restic/restic:0.19.1 AS restic

FROM gcr.io/distroless/nodejs24-debian12 AS runtime

ARG KILN_GIT_REPO=https://github.com/kiln-site/kiln
ENV KILN_GIT_REPO=$KILN_GIT_REPO
ENV KILN_DEFAULT_GIT_REPO=$KILN_GIT_REPO
ENV NODE_ENV=production
ARG SENTRY_DSN
ENV SENTRY_DSN=$SENTRY_DSN
ENV SENTRY_TRACES_SAMPLE_RATE=0.05
WORKDIR /app

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=restic /usr/bin/restic /usr/bin/restic
COPY --from=runtime-deps /runtime/node_modules ./node_modules
COPY apps/relay/package.runtime.json ./package.json
RUN ["/nodejs/bin/node", "--input-type=module", "-e", "await import('reflect-metadata'); const manifest = await import('./package.json', { with: { type: 'json' } }); await Promise.all(Object.keys(manifest.default.dependencies).map((name) => import(name)))"]
COPY --from=build /source/apps/relay/dist ./dist
COPY --chmod=755 apps/relay/bin/kiln-relay.mjs /usr/local/bin/kiln-relay

ARG KILN_VERSION
ARG SOURCE_COMMIT

# Keep the legacy source label until older Relays have received the
# repository-rename compatibility check.
ARG KILN_IMAGE_SOURCE=https://github.com/kiln-site/hearth
LABEL org.opencontainers.image.source="${KILN_IMAGE_SOURCE}" \
  org.opencontainers.image.version="${KILN_VERSION}" \
  org.opencontainers.image.revision="${SOURCE_COMMIT}" \
  io.kiln.component="relay"

EXPOSE 4100 2022
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const proxy=process.env.KILN_RELAY_PROXY;const plain=proxy==='coolify'||proxy==='traefik';const request=require(plain?'node:http':'node:https').get({host:'127.0.0.1',port:process.env.KILN_RELAY_PORT||'4100',path:'/health',rejectUnauthorized:false,timeout:2500},response=>process.exit(response.statusCode===204?0:1));request.on('error',()=>process.exit(1));request.on('timeout',()=>request.destroy())"]
CMD ["--import", "./dist/instrument.mjs", "dist/src/index.mjs"]
