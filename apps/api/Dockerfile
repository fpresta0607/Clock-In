# Built from the repository root so the workspace packages the API imports are
# available:  docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo

RUN corepack enable

# Manifests first, so a dependency install is only redone when they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @clock-in/api...

COPY packages/shared packages/shared
COPY packages/database packages/database
COPY apps/api apps/api
RUN pnpm --filter @clock-in/api build

# Reinstall without dev dependencies so the runtime image carries only what it runs.
RUN pnpm install --frozen-lockfile --prod --filter @clock-in/api...

FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json package.json
COPY --from=build /repo/packages/shared/package.json packages/shared/package.json
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/shared/node_modules packages/shared/node_modules
COPY --from=build /repo/packages/database/package.json packages/database/package.json
COPY --from=build /repo/packages/database/dist packages/database/dist
COPY --from=build /repo/packages/database/migrations packages/database/migrations
COPY --from=build /repo/packages/database/node_modules packages/database/node_modules
COPY --from=build /repo/apps/api/package.json apps/api/package.json
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/node_modules apps/api/node_modules

# Never run as root; the image needs no write access of its own.
USER node
EXPOSE 3000

# The process handles SIGTERM itself, so run it as PID 1 rather than under a shell.
CMD ["node", "apps/api/dist/server.js"]
