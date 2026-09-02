# syntax=docker/dockerfile:1.7
# Build only the API dependency graph, then install production dependencies in
# a separate layer so source changes do not rerun a production prune.
FROM node:24-bookworm-slim AS build
WORKDIR /workspace

COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
RUN --mount=type=cache,id=dglab-pulse-hub-npm,target=/root/.npm \
  npm ci --workspace @dglab-pulse-hub/api --include-workspace-root=true \
    --ignore-scripts --no-audit --fund=false

COPY . .
RUN npm run api:build

FROM node:24-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
ENV PULSE_API_HOST=0.0.0.0
ENV PULSE_API_PORT=8787

COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/packages/application/package.json ./packages/application/package.json
COPY --from=build /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /workspace/packages/core/package.json ./packages/core/package.json
RUN --mount=type=cache,id=dglab-pulse-hub-npm,target=/root/.npm \
  npm ci --omit=dev --workspace @dglab-pulse-hub/api \
    --include-workspace-root=false --ignore-scripts --no-audit --fund=false

COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/packages/core/dist ./packages/core/dist
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /workspace/packages/application/dist ./packages/application/dist

EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD node -e \
  "fetch('http://127.0.0.1:8787/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
