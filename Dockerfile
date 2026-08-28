# --- build ------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall runs `prisma generate`, so the client is built here.
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
COPY prisma ./prisma
COPY prisma.config.ts package.json ./

# OSC replies arrive on the ephemeral UDP port the process binds, so nothing
# needs publishing for the console link itself — only the HTTP API.
EXPOSE 3000
USER node

# Migrations run before the API accepts traffic, so `docker compose up` on a
# fresh volume comes up with a working database rather than a 500 on first use.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node dist/main.js"]
