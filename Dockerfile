# Shared image for the worker and server Compose services. Dependency layer
# is cached; code changes only rebuild the COPY layers. The web client stays
# host-run (`pnpm dev:web`) — it's a viewer, not part of the always-on pipeline.
FROM node:22-alpine

# pnpm installed directly, NOT via corepack: fresh node:22 images ship a
# corepack that silently no-ops without a packageManager pin (bit us on the
# Pi 5 bring-up — containers exit-0-looped). npm -g is deterministic.
RUN npm install -g pnpm@9
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/worker ./apps/worker

# command comes from each compose service
