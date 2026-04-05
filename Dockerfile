FROM oven/bun:1 AS base
WORKDIR /app

RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base
WORKDIR /app

COPY --from=install /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY drizzle.config.ts ./

RUN mkdir -p /root/.config

EXPOSE 3000

CMD ["bun", "src/index.ts"]
