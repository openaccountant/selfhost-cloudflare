# Open Accountant (wilson) self-host image for Cloudflare Containers.
# Base tag MUST match the @cloudflare/sandbox version in package.json.
FROM docker.io/cloudflare/sandbox:0.12.14

# Published wilson release from npm. Bump deliberately.
ARG WILSON_VERSION=0.10.0
ENV WILSON_DIR=/opt/wilson

RUN set -eux; \
    mkdir -p /opt/wilson-src && cd /opt/wilson-src; \
    npm pack "@openaccountant/wilson@${WILSON_VERSION}"; \
    tar xzf openaccountant-wilson-*.tgz; \
    mv package "$WILSON_DIR"; cd "$WILSON_DIR"; rm -rf /opt/wilson-src; \
    bun install --production; \
    cd src/dashboard/ui; bun install; bun x vite build; \
    test -f dist/index.html; rm -rf node_modules

RUN printf '#!/bin/sh\nexec bun "%s/src/index.tsx" "$@"\n' "$WILSON_DIR" > /usr/local/bin/wilson \
    && chmod +x /usr/local/bin/wilson

COPY container/ /opt/oa/
RUN printf '%s\n' 'cd ~' >> /root/.bashrc
WORKDIR /root
