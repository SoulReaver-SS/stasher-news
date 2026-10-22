# syntax=docker/dockerfile:1

FROM node:22.23.4-bookworm

ENV NODE_ENV=development

ARG UID
ARG GID
RUN groupadd -fg "$GID" apprunner
RUN useradd -om -u "$UID" -g "$GID" apprunner

WORKDIR /app

# pg_dump/psql for scripts/deploy-migrate.sh (pre-migration snapshot + rollback).
# Bookworm's default client is v15, which mismatches postgres 16. Pull v16 from
# the live PGDG repo (bullseye went EOL 2026-08-31 and node stopped publishing
# bullseye images, which forced this base move).
RUN curl -sL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*

EXPOSE 3000

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --loglevel verbose

USER apprunner

# node_modules is bind-mounted from the host in local dev, shared by app and
# worker. npm ci deletes and reinstalls the whole tree, so it only runs when
# node_modules is missing/incomplete or package-lock.json changed since the
# last install (stamped in .npm-installed-stamp). An unconditional reinstall
# on every start wipes the shared tree mid-flight and can kill the worker
# container (observed: Cannot find module tsx/dist/preflight.cjs, all pg-boss
# jobs dead until a manual worker restart).
# migrate deploy is non-interactive (migrate dev prompts on drift and hangs in a
# non-tty container); run migrate dev manually via `./sndev prisma migrate dev`
# prisma generate runs on EVERY boot: schema-only migrations leave
# package-lock.json unchanged, so the npm ci above is skipped and
# @prisma/client's postinstall never regenerates the client — while migrate
# deploy still applies the new column, and every query touching it then dies
# with PrismaClientValidationError (observed 2026-08-16: DownvotePidMap
# webhookEventId broke downvote creation + hourly webhookCleanup on the VPS).
# generate is idempotent (~5-10 s) and needs no DB connection.
CMD ["sh","-c","set -e\nlockhash=$(md5sum package-lock.json | cut -d' ' -f1)\nif [ -f .npm-installed-stamp ] && [ \"$(cat .npm-installed-stamp)\" = \"$lockhash\" ] && [ -f node_modules/.package-lock.json ]; then\n  echo 'node_modules up to date (lockfile unchanged), skipping npm ci'\nelse\n  npm ci --legacy-peer-deps --loglevel verbose\n  printf '%s\\n' \"$lockhash\" > .npm-installed-stamp\nfi\nnpx prisma generate && npx prisma migrate deploy && npm run dev"]
