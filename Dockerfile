FROM node:20-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public

RUN pnpm install --frozen-lockfile
RUN pnpm build && pnpm build:server
RUN pnpm prune --prod

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Origin the container is served from. Override this (or pass -e APP_ORIGIN=...)
# with your own deployment URL before running.
ENV APP_ORIGIN=http://localhost:3000

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/server/server/index.js"]
