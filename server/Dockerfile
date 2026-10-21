# The api and worker images (design §11). One codebase, two targets:
#   api     Node only
#   worker  Node + Debian's Chromium — Google ships no Chrome for Linux ARM,
#           which the Oracle VM is (design §7.10, §14.1)
# Build context is the repo root (see .dockerignore — no spike data, no .env).

FROM node:22-bookworm-slim AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci

FROM deps AS build
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist ./dist
COPY server/db ./db

FROM runtime AS api
USER node
CMD ["node", "dist/api/main.js"]

FROM runtime AS worker
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
USER node
CMD ["node", "dist/worker/main.js"]
