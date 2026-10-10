FROM oven/bun:1.4.0-slim AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN bun run build

FROM oven/bun:1.4.0-slim AS production-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM node:24-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=production-deps /app/node_modules ./node_modules
COPY package.json LICENSE ./
USER node

EXPOSE 8443
CMD ["node", "dist/index.js", "/app/config.yaml"]
