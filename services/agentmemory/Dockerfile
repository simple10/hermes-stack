# agentmemory image. There is NO published agentmemory image (verified
# empirically: the generic iiidev/iii image 404s every /agentmemory/* route).
# agentmemory IS a prebuilt npm package that runs ON the iii engine, so we
# npm-install the PUBLISHED, maintainer-tested release and copy the pinned
# iii engine binary in from iiidev/iii. We deliberately consume the released
# tarball (ships dist/ + bundled iii-config*.yaml) rather than building from
# source: the npm artifact is what upstream tests/ships, and this project's
# build toolchain is the fragile part. To move to newer "stable" code, bump
# AGENTMEMORY_VERSION (npm releases track the git tags 1:1).
ARG III_VERSION=0.11.2

FROM iiidev/iii:${III_VERSION} AS iii

FROM node:22-slim

ARG AGENTMEMORY_VERSION=0.9.18
ARG III_VERSION=0.11.2
ARG III_SDK_VERSION=0.11.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini gosu curl socat \
 && rm -rf /var/lib/apt/lists/*

COPY --from=iii /app/iii /usr/local/bin/iii
RUN chmod +x /usr/local/bin/iii

WORKDIR /opt/agentmemory
RUN printf '{"name":"agentmemory-deploy","version":"1.0.0","private":true,"overrides":{"iii-sdk":"%s"}}\n' "${III_SDK_VERSION}" > package.json \
 && npm install "@agentmemory/agentmemory@${AGENTMEMORY_VERSION}" --omit=optional --no-fund --no-audit \
 && ln -sf /opt/agentmemory/node_modules/.bin/agentmemory /usr/local/bin/agentmemory

ENV AGENTMEMORY_III_VERSION=${III_VERSION} \
    TINI_SUBREAPER=1

COPY --chmod=0755 entrypoint.sh /usr/local/bin/agentmemory-entrypoint.sh

EXPOSE 3111 3112

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3111/agentmemory/livez || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentmemory-entrypoint.sh"]
