# syntax=docker/dockerfile:1.7
# Kiln's desktop streamer: voxl (https://github.com/tembo/voxl), which streams
# an X11 display to the browser as H.264 over a WebSocket. The Relay runs it
# beside the node's own display server and passes the browser's connection
# through Hearth to it. voxl is MIT, but it links x264 (GPL-2.0), so this
# image is distributed under the GPL, separately from Kiln's own images.
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

FROM debian:trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates libopus0 libpulse0 libx264-164 libxcb1 libyuv0 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/voxl/bin/voxl /usr/local/bin/voxl
LABEL org.opencontainers.image.source="https://github.com/kiln-site/kiln" \
  org.opencontainers.image.licenses="GPL-2.0-or-later" \
  org.opencontainers.image.description="voxl desktop streamer for Kiln Relays"
ENTRYPOINT ["/usr/local/bin/voxl"]
