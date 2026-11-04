# syntax=docker/dockerfile:1.7
# Kiln's desktop streamer: voxl (https://github.com/tembo/voxl), which streams
# an X11 display to the browser as H.264 over a WebSocket. The Relay runs it
# beside the node's own display server and passes the browser's connection
# through Hearth to it. It also holds the encoder a Mac's picture goes through
# (encoder.c). Build it from the repository's root. voxl is MIT, but it links
# x264 (GPL-2.0), so this
# image is distributed under the GPL, separately from Kiln's own images. The
# source of the libraries it adds ships inside it, and voxl's beside it (the
# `source` target).
#
# A new version also needs KILN_DESKTOP_IMAGE_TAG and the client Hearth serves
# (docs/relay-desktop.md); scripts/desktop-image.test.mjs checks they agree. Any
# other change raises the revision, as Relays keep the image a tag named.
ARG VOXL_VERSION=0.3.2
ARG DESKTOP_IMAGE_REVISION=1

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
# The licenses of voxl and the crates built into it go where the binary goes,
# nested ones too: voxl embeds a font, and some crates' tables have their own.
RUN mkdir /opt/voxl/licenses \
  && cd /usr/local/cargo/registry/src/*/ \
  && find . -type f ! -name '*.rs' \
    \( -iname '*LICEN[CS]E*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) \
    -exec cp --parents -t /opt/voxl/licenses {} +
COPY apps/desktop/encoder.c /opt/voxl/encoder.c
RUN gcc -O2 -Wall -Wextra -Werror /opt/voxl/encoder.c -lx264 -lyuv \
    -o /opt/voxl/bin/kiln-desktop-encoder

# voxl's source and the crates built into it, which a version pins exactly, and
# the encoder's.
# Published as `desktop:<version>-source`, from the same place as the image.
FROM rust:1.91-slim-trixie AS source-files
ARG VOXL_VERSION
ARG KILN_GIT_REPO=https://github.com/kiln-site/kiln
ARG SOURCE_COMMIT=main
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && mkdir /src \
  && cd /src \
  && curl -fsSL "https://static.crates.io/crates/voxl-server/voxl-server-${VOXL_VERSION}.crate" \
    | tar -xz \
  && cd "voxl-server-${VOXL_VERSION}" \
  && mkdir .cargo \
  && cargo vendor --locked --versioned-dirs ../vendor > .cargo/config.toml
COPY apps/desktop/encoder.c /src/encoder.c
RUN printf '%s\n' \
    "voxl-server-${VOXL_VERSION}: voxl, set up to build from vendor/." \
    'encoder.c: the encoder for a Mac, GPL-2.0-or-later.' \
    "How it's built: ${KILN_GIT_REPO}/blob/${SOURCE_COMMIT}/apps/desktop/Dockerfile" \
  > /src/README

FROM scratch AS source
COPY --from=source-files /src /src

# Certificates go in first: what the second install adds is everything voxl's
# libraries bring, however deep, and it's all that source-packages lists.
FROM debian:trixie-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && dpkg-query -W -f '${Package}\n' | sort > /tmp/before \
  && apt-get install -y --no-install-recommends \
    libopus0 libpulse0 libx264-164 libxcb1 libyuv0 \
  && mkdir -p /usr/share/doc/voxl \
  && dpkg-query -W -f '${Package}\n' | sort | comm -13 /tmp/before - \
    | xargs dpkg-query -W -f '${source:Package}=${source:Version}\n' | sort -u \
    > /usr/share/doc/voxl/source-packages \
  && dpkg-query -W -f '${Package} ${Version} ${source:Package} ${source:Version}\n' \
    > /usr/share/doc/voxl/debian-packages \
  && rm -rf /var/lib/apt/lists/* /tmp/before

# The source of those libraries, at the versions this image installed. It goes
# in the image, so the two can't drift apart.
FROM runtime AS debian-source
RUN sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends dpkg-dev \
  && mkdir /debian \
  && cd /debian \
  && apt-get source --download-only $(cat /usr/share/doc/voxl/source-packages)

FROM runtime
COPY --from=build /opt/voxl/bin/voxl /opt/voxl/bin/kiln-desktop-encoder /usr/local/bin/
COPY --from=build /opt/voxl/licenses /usr/share/doc/voxl/licenses
COPY --from=debian-source /debian /usr/share/doc/voxl/source
# Fails the build if a library it links is missing.
RUN ["/usr/local/bin/voxl", "--version"]
RUN printf '%s\n' \
    'voxl is MIT licensed, but this binary links x264, so it is distributed' \
    'under the GPL: see /usr/share/common-licenses/GPL-2. The source of the' \
    'libraries this image adds to Debian, listed in source-packages, is in' \
    'source/. The source of voxl and the crates built into it is published' \
    'beside this image, under this tag followed by -source. Their licenses' \
    'are in licenses/. debian-packages lists every Debian package here,' \
    "including Debian's base image, whose source is in Debian's archive at" \
    'https://snapshot.debian.org.' \
  > /usr/share/doc/voxl/NOTICE
LABEL org.opencontainers.image.source="https://github.com/kiln-site/kiln" \
  org.opencontainers.image.licenses="GPL-2.0-or-later" \
  org.opencontainers.image.description="voxl desktop streamer for Kiln Relays"
ENTRYPOINT ["/usr/local/bin/voxl"]
