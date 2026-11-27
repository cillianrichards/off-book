# The live app as one image (P2-01): the Node.js server, which also serves the client's bundle, so the
# API, the game WebSocket and the client share one origin. Built and smoke-tested in CI, and deployed to
# Azure Container Apps from GitHub Actions.
#
# The server runs its TypeScript sources directly, with Node's type stripping, as it does in
# development, so there is no compile step for it. Node is pinned to an exact release; pin it by digest
# as well when one can be read from Docker Hub, as compose.yaml pins PostgreSQL.

ARG NODE_IMAGE=node:24.22.3-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN npm install --global pnpm@12.15.0
# Manifests first, so dependencies are cached until one changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/rules/package.json packages/rules/
COPY tools/licence-check/package.json tools/licence-check/
RUN pnpm install --frozen-lockfile --filter @off-book/client...
COPY tsconfig.base.json ./
COPY packages/rules packages/rules
COPY apps/client apps/client
RUN pnpm --filter @off-book/client build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm install --global pnpm@12.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/rules/package.json packages/rules/
COPY tools/licence-check/package.json tools/licence-check/
# Only the server and what it needs at run time; workspace packages stay symlinked outside
# node_modules, where Node will strip their types.
RUN pnpm install --frozen-lockfile --prod --filter @off-book/server... && npm uninstall --global pnpm
COPY LICENSE THIRD_PARTY_LICENCES.md ./
COPY packages/rules/src packages/rules/src
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/client/dist apps/client/dist
ENV OFF_BOOK_CLIENT_DIR=/app/apps/client/dist
ENV PORT=8080
EXPOSE 8080
USER node
# Exec form, so the server is PID 1 and receives SIGTERM, saving every game before it stops (P2-08).
CMD ["node", "apps/server/src/main.ts"]
