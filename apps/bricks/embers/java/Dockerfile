ARG JAVA_VERSION=21
FROM eclipse-temurin:${JAVA_VERSION}-jdk-jammy AS java

RUN apt-get update \
  && apt-get install -y --no-install-recommends binutils \
  && rm -rf /var/lib/apt/lists/*

# java.se is the public Java SE API set, including java.scripting. Paper/Purpur
# load javax.script during bootstrap, and Pterodactyl yolks avoid this class of
# crash by shipping a full Temurin JDK. Extra jdk.* modules cover TLS, locales,
# Spark, and the incubator Vector API used by the Purpur egg when present.
# Forge's coremods run JavaScript: jdk.dynalink backs the Nashorn library it
# ships from 1.17, and Java 11's own Nashorn runs them before that.
RUN compression=2; \
  if jlink --help | grep -q 'zip-[0-9]'; then compression=zip-6; fi; \
  modules="java.se,jdk.attach,jdk.charsets,jdk.crypto.cryptoki,jdk.crypto.ec,jdk.dynalink,jdk.httpserver,jdk.jfr,jdk.localedata,jdk.management,jdk.naming.dns,jdk.net,jdk.security.auth,jdk.security.jgss,jdk.unsupported,jdk.xml.dom,jdk.zipfs"; \
  for optional in jdk.incubator.vector jdk.scripting.nashorn; do \
    if java --list-modules | grep -q "^${optional}@"; then \
      modules="${modules},${optional}"; \
    fi; \
  done; \
  jlink \
  --add-modules "${modules}" \
  --no-header-files \
  --no-man-pages \
  --strip-debug \
  --compress="${compression}" \
  --output /opt/kiln-java

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl fontconfig libfreetype6 tini tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY --from=java /opt/kiln-java /opt/java
COPY apps/bricks/embers/java/entrypoint.sh /usr/local/bin/kiln-ember
RUN chmod 0755 /usr/local/bin/kiln-ember && mkdir -p /server

ARG KILN_GIT_REPO=https://github.com/kiln-site/kiln
LABEL org.opencontainers.image.source="${KILN_GIT_REPO}"
LABEL org.opencontainers.image.title="Kiln Java Ember"
LABEL org.opencontainers.image.description="Minimal Java runtime for recipe-driven Kiln Bricks"
LABEL kiln.ember.installation-marker="v1"

ENV JAVA_HOME=/opt/java
ENV PATH=/opt/java/bin:$PATH
WORKDIR /server
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kiln-ember"]
