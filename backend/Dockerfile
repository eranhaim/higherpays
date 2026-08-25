# HigherPays backend — slim Node 22 image on Alpine.
#
# The container waits for Postgres, runs migrations as `postgres` (superuser),
# then boots the server as the restricted `hp_app` role (see entrypoint.sh).
# The process runs as the unprivileged `node` user: a compromise of the API
# does not hand out root inside the container.
FROM node:22-alpine

WORKDIR /app

# `postgresql-client` gives us pg_isready + psql for the entrypoint script.
# `tini` is a tiny init that reaps zombies and forwards signals cleanly.
RUN apk add --no-cache postgresql-client tini

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node
ENTRYPOINT ["/sbin/tini", "--", "sh", "/app/entrypoint.sh"]
