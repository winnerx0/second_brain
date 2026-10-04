FROM node:slim as base

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production

RUN bun run build

FROM node:slim as final

WORKDIR /app

COPY --from=base /app/dist /dist

RUN 