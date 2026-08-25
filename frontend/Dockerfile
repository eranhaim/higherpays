# HigherPays frontend — Vite build on Alpine, served by unprivileged nginx.
#
# Two stages: a bulky build stage that compiles TypeScript + Vite, then a slim
# nginx runtime image that only ships the compiled assets and the reverse-proxy
# config for /api → backend. The runtime image runs nginx as a non-root user
# on port 8080.

# --- Build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# The API base URL is baked into the bundle by Vite at build time. We default
# to `/api` so the served app talks to the same origin (proxied by nginx),
# which sidesteps CORS. Compose can override with `--build-arg VITE_API_URL=...`.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

# .npmrc carries legacy-peer-deps for the a11y lint plugin; npm ci needs it too.
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

# --- Runtime ----------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
