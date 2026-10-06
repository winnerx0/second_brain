FROM docker.io/oven/bun:latest AS base
WORKDIR /app

RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
# COPY .config/google-docs-mcp /root/.config/google-docs-mcp
RUN bun build --target=bun --production --external oluso --outfile=dist/index.js --minify ./src/index.ts
RUN bun build --target=bun --production --outfile=dist/worker.js --minify ./src/workflows/worker.ts

FROM base AS final
WORKDIR /app
COPY package.json bun.lock ./
COPY --from=build /app/dist ./dist
RUN bun install --frozen-lockfile --production
COPY package.json bun.lock tsconfig.json ./
COPY src/db ./src/db
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY skills ./skills
# COPY .config/google-docs-mcp /root/.config/google-docs-mcp

EXPOSE 3005

CMD ["bun", "start"]
