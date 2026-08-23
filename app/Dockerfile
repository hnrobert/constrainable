# syntax=docker/dockerfile:1
# constrainable-app: Nuxt full-stack (SSR frontend + API backend + Socket.IO).
# Pairs with constrainable-media-node (separate repo) for distributed ingest.
#
# LAYER STRATEGY (pull size per code change ≈ the .output layer only):
#  - deps / prod-deps stages install from the LOCKFILE — byte-identical while
#    the lockfile is unchanged (BuildKit+GHA cache serves the same layer blob),
#    so the runtime's node_modules layer dedups on the registry.
#  - The runtime must NOT take node_modules from the build stage: `nuxt build`
#    writes into node_modules/.cache, which changes those bytes EVERY build
#    and used to force a full ~100MB re-pull on each deploy.
#  - Order in runtime: static base → deps layer (changes on dependency
#    changes) → .output + configs (change every build, ~17MB).
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

# Production-only tree for the runtime image (drizzle-kit lives in
# `dependencies` — the server runs it at boot for schema sync).
FROM oven/bun:1 AS prod-deps
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --production --frozen-lockfile || bun install --production

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

COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/.output /app/.output
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/drizzle.config.ts /app/drizzle.config.ts
COPY --from=build /app/server/database/schema.ts /app/server/database/schema.ts

VOLUME ["/app/data", "/app/records"]
EXPOSE 31954

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "/app/.output/server/index.mjs"]
