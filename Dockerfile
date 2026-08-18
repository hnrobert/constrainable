# syntax=docker/dockerfile:1
# constrainable-app: Nuxt full-stack (SSR frontend + API backend + Socket.IO).
# Pairs with constrainable-media-node (separate repo) for distributed ingest.
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM oven/bun:1 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=31954 \
    TZ=Asia/Shanghai

COPY --from=build /app/.output /app/.output
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/drizzle.config.ts /app/drizzle.config.ts
COPY --from=build /app/server/database/schema.ts /app/server/database/schema.ts

VOLUME ["/app/data", "/app/records"]
EXPOSE 31954

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "/app/.output/server/index.mjs"]
