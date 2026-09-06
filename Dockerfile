# ---------------------------------------------------------------------------
# build: compile TypeScript and build the native better-sqlite3 binding
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# better-sqlite3 has no prebuilt binary for every alpine/node combination,
# so the toolchain has to be present while installing.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# Reinstall without dev dependencies, reusing the compiled native module.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine

# su-exec drops privileges after the entrypoint has fixed up ids; shadow
# provides usermod/groupmod for the PUID/PGID dance the *arr images use.
RUN apk add --no-cache su-exec shadow tini

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Same conventions as the linuxserver.io *arr containers
ENV PUID=1000 \
    PGID=1000 \
    TZ=Europe/Oslo \
    UMASK_SET=022 \
    NODE_ENV=production \
    SUGGESTARR_DB_PATH=/config/suggestarr.db

VOLUME ["/config"]

HEALTHCHECK --interval=5m --timeout=30s --start-period=30s --retries=3 \
  CMD node dist/main.js health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/main.js", "bot"]
