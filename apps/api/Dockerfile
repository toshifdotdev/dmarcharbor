# syntax=docker/dockerfile:1

# A monorepo workspace with the API as the only thing built into an image.
#
# The context is the repository root, not apps/api, because the API's dependencies
# are hoisted to the root node_modules by the workspace layout. Building from
# apps/api alone would install a second, divergent copy of Prisma and Express.

FROM node:22-alpine AS build

# OpensSSL is what Prisma's query engine links against on Alpine. Without it
# `prisma generate` produces a client that fails at runtime with a missing shared
# object rather than at build time, which is the worst place to find out.
RUN apk add --no-cache openssl

WORKDIR /repo

# Manifests first, so a source-only change does not re-run the install layer. The
# lockfile is copied without the sources so npm cannot try to run the workspace
# postinstall, which needs a schema that is not here yet.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# Named rather than `workers/*/package.json`, because Docker flattens a multi
# source glob into one destination directory, which would collapse the workspaces
# into a single package.json and break the root workspace glob.
COPY workers/report-ingress/package.json workers/report-ingress/package.json

RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY apps/api ./apps/api

# Generation needs the schema, which arrives with the sources above.
RUN npm run db:generate --workspace @dmarcharbor/api \
  && npm run build --workspace @dmarcharbor/api


FROM node:22-alpine AS runtime

# tini reaps the zombies and, more importantly, forwards SIGTERM to Node.
#
# Without an init, Node runs as PID 1, which does not install the default signal
# handlers the way a shell does. The orchestrator sends SIGTERM to PID 1, Node
# ignores it, the grace period runs out and the pod is SIGKILLed mid-request. The
# graceful shutdown this service implements would then never run at all.
RUN apk add --no-cache openssl tini

ENV NODE_ENV=production

# The workspace layout is preserved rather than flattened.
#
# npm hoists most packages to the root and nests the ones whose versions conflict, so
# `node_modules/@noble/hashes` and `apps/api/node_modules/@noble/hashes` are genuinely
# different versions of the same package, each placed for the dependent that needs it.
# Copying both into one directory merges them and the later copy wins, which silently
# hands pdfkit the v2 of @noble/hashes it was never compatible with: the image builds,
# every test passes on the developer's machine, and the container dies at boot on
# `ERR_PACKAGE_PATH_NOT_EXPORTED`.
#
# Keeping the paths they were installed at means Node resolves exactly what it
# resolved locally, which is the only arrangement that can be trusted.
WORKDIR /app

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/package.json ./package.json

WORKDIR /app/apps/api

# Unprivileged. The node image ships a `node` user and nothing in this service
# needs to write to its own filesystem; a container escape should not start from a
# root process inside it.
USER node

EXPOSE 4000

# Readiness, not liveness.
#
# `/ready` is the database check, so a container whose database is unreachable is
# taken out of rotation instead of receiving traffic it cannot serve. It also
# reports scheduler staleness, which is the only place a silently dead schedule
# becomes visible. Using `/health` here would report "ok" for a replica that can
# answer nothing, which is how a database outage turns into an outage everywhere.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]

# `dumb-init`-style entrypoint wrapper running migrations before the server.
#
# Migrations run here rather than by hand because a deploy that forgets them starts
# a new binary against an old schema, and the failure surfaces as a missing column
# on the first request that touches it rather than as a failed deploy. The schema
# check in the application is the backstop for the case where this is skipped
# entirely.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]