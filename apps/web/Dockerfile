# syntax=docker/dockerfile:1

# The web app (marketing pages, the console and the client portal) as one image.
#
# Built from the repository root, like the API image, because dependencies are
# hoisted to the root node_modules and the pages read ../../docs at runtime
# (lib/docs-registry.ts, lib/legal-docs.ts).
#
# NEXT_PUBLIC_* values and the /api rewrite target are fixed when `next build`
# runs, so they are build arguments, not runtime settings. One image per
# deployment: a staging image cannot be promoted to production.

FROM node:22-alpine AS build

WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY workers/report-ingress/package.json workers/report-ingress/package.json

RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY apps/web ./apps/web
COPY docs ./docs

# Where the server proxies /api/* (next.config.ts rewrites): the API container
# on the compose network, with no /api suffix.
ARG API_BASE_URL=http://api:4000
# Our one public origin and its hostname (lib/site-config.ts validates both).
ARG SITE_URL
ARG NEXT_PUBLIC_APP_HOST
# Paddle's client token is public by design; empty leaves card checkout off.
ARG NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone \
    API_BASE_URL=${API_BASE_URL} \
    SITE_URL=${SITE_URL} \
    NEXT_PUBLIC_APP_HOST=${NEXT_PUBLIC_APP_HOST} \
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=${NEXT_PUBLIC_PADDLE_CLIENT_TOKEN}

RUN npm run build --workspace @dmarcharbor/web


FROM node:22-alpine AS runtime

RUN apk add --no-cache tini

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# The standalone server keeps the monorepo layout under /app, with the server
# at apps/web/server.js. Static files, public/ and the files read with fs at
# runtime are not traced, so they are copied to where process.cwd() finds them.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/app/_og ./apps/web/app/_og
COPY --from=build /repo/docs ./docs

WORKDIR /app/apps/web

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/robots.txt" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
