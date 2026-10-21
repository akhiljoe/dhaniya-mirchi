# The web image: the React SPA built by Vite, served by nginx, which also
# proxies /api and /auth to the api service (design §11).
# Build context is the repo root.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json tailwind.config.js postcss.config.js ./
COPY src ./src
COPY public ./public
RUN npx vite build

FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
