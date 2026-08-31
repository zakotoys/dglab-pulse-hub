# Build the API and all workspace packages once, then ship only compiled output
# and the locked dependency tree in the runtime image.
FROM node:24-bookworm-slim AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build
# Keep Electron, Forge, TypeScript, and other build-only packages out of the
# API runtime image. Workspace production links remain available for imports.
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
ENV PULSE_API_HOST=0.0.0.0
ENV PULSE_API_PORT=8787

COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/packages/core/package.json ./packages/core/package.json
COPY --from=build /workspace/packages/core/dist ./packages/core/dist
COPY --from=build /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /workspace/packages/application/package.json ./packages/application/package.json
COPY --from=build /workspace/packages/application/dist ./packages/application/dist

EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
