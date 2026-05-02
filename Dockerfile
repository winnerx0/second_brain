FROM oven/bun:1 AS base
WORKDIR /app

RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS build
WORKDIR /app
COPY --from=install /app/node_modules ./node_modules
COPY src ./src
# COPY .config/google-docs-mcp /root/.config/google-docs-mcp
RUN bun build --target=bun --production --outfile=dist/index.js --minify ./src/index.ts  

FROM base AS final
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=install /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src/db ./src/db
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
# COPY .config/google-docs-mcp /root/.config/google-docs-mcp

EXPOSE 3005

CMD ["bun", "start"]
