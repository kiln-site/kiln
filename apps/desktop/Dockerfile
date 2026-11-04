# syntax=docker/dockerfile:1.7
# Kiln's desktop streamer: voxl (https://github.com/tembo/voxl), which streams
# an X11 display to the browser as H.264 over a WebSocket. The Relay runs it
# beside the node's own display server and passes the browser's connection
# through Hearth to it. voxl is MIT, but it links x264 (GPL-2.0), so this
# image is distributed under the GPL, separately from Kiln's own images, with
# its source beside it (the `source` target).
#
# A new version also needs KILN_DESKTOP_IMAGE_TAG and the client Hearth serves
# (docs/relay-desktop.md); scripts/desktop-image.test.mjs checks they agree.
ARG VOXL_VERSION=0.3.2

FROM rust:1.91-slim-trixie AS build
ARG VOXL_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    clang esbuild libclang-dev libopus-dev libpulse-dev libx264-dev libxcb1-dev \
    libyuv-dev \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*
# Debian's libyuv-dev ships no pkg-config file, which voxl's build looks for.
RUN printf '%s\n' 'prefix=/usr' 'libdir=${prefix}/lib/x86_64-linux-gnu' \
    'includedir=${prefix}/include' 'Name: libyuv' 'Description: libyuv' \
    'Version: 0.0.1904' 'Libs: -L${libdir} -lyuv' 'Cflags: -I${includedir}' \
  | sed "s|x86_64-linux-gnu|$(gcc -dumpmachine)|" \
  > /usr/share/pkgconfig/libyuv.pc
RUN cargo install voxl-server --version "${VOXL_VERSION}" --locked --root /opt/voxl
# The licenses of voxl and the crates built into it go where the binary goes.
RUN find /usr/local/cargo/registry/src -mindepth 3 -maxdepth 3 -type f \
    \( -iname 'LICEN[CS]E*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) \
    -exec sh -c 'for file; do \
      directory="/opt/voxl/licenses/$(basename "$(dirname "$file")")"; \
      mkdir -p "$directory" && cp "$file" "$directory/"; \
    done' sh {} +

# The source of what the GPL covers: voxl and the crates built into it, and
# Debian's x264 and PulseAudio, which it links. Published as
# `desktop:<version>-source`, from the same place as the image. It starts from
# the build stage to take the exact versions the build installed.
FROM build AS source-files
ARG VOXL_VERSION
ARG KILN_GIT_REPO=https://github.com/kiln-site/kiln
ARG SOURCE_COMMIT=main
RUN packages="$(dpkg-query -W -f '${source:Package}=${source:Version}\n' libx264-dev libpulse-dev)" \
  && sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends curl dpkg-dev \
  && mkdir -p /src/debian \
  && cd /src/debian \
  && apt-get source --download-only $packages \
  && cd /src \
  && curl -fsSL "https://static.crates.io/crates/voxl-server/voxl-server-${VOXL_VERSION}.crate" \
    | tar -xz \
  && cd "voxl-server-${VOXL_VERSION}" \
  && mkdir .cargo \
  && cargo vendor --locked --versioned-dirs ../vendor > .cargo/config.toml
RUN printf '%s\n' \
    "voxl-server-${VOXL_VERSION}: voxl, set up to build from vendor/." \
    'debian: the x264 and PulseAudio the image links.' \
    "How it's built: ${KILN_GIT_REPO}/blob/${SOURCE_COMMIT}/apps/desktop/Dockerfile" \
  > /src/README

FROM scratch AS source
COPY --from=source-files /src /src

FROM debian:trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates libopus0 libpulse0 libx264-164 libxcb1 libyuv0 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/voxl/bin/voxl /usr/local/bin/voxl
COPY --from=build /opt/voxl/licenses /usr/share/doc/voxl/licenses
# Fails the build if a library it links is missing.
RUN ["/usr/local/bin/voxl", "--version"]
RUN printf '%s\n' \
    'voxl is MIT licensed, but this binary links x264, so it is distributed' \
    'under the GPL: see /usr/share/common-licenses/GPL-2. Its complete source' \
    'is published beside this image, under this tag followed by -source.' \
    'The licenses of voxl and the crates built into it are in licenses/.' \
  > /usr/share/doc/voxl/NOTICE
LABEL org.opencontainers.image.source="https://github.com/kiln-site/kiln" \
  org.opencontainers.image.licenses="GPL-2.0-or-later" \
  org.opencontainers.image.description="voxl desktop streamer for Kiln Relays"
ENTRYPOINT ["/usr/local/bin/voxl"]
