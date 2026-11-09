# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY migrations ./migrations
COPY README.md LICENSE ./
RUN npm run build \
 && npm pack --pack-destination /tmp

FROM ${NODE_IMAGE} AS runtime
ARG IMAGE_REVISION=unknown
ARG IMAGE_VERSION=0.1.0-dev
WORKDIR /app
ENV NODE_ENV=production PORT=3200 HOST=0.0.0.0
LABEL org.opencontainers.image.source="https://github.com/AgentWorkforce/relaychief-control" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY package.json package-lock.json ./
COPY --from=build /tmp/relaychief-control-*.tgz /tmp/package.tgz
# npm ci keeps production dependencies at the locked versions the build tested.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && mkdir node_modules/relaychief-control \
 && tar -xzf /tmp/package.tgz --strip-components=1 -C node_modules/relaychief-control \
 && rm /tmp/package.tgz \
 && chown -R node:node /app
# Numeric so Kubernetes runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/relaychief-control/dist/server.js"]
