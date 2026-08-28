# --- build ------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
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
COPY package.json ./

# OSC replies arrive on the ephemeral UDP port the process binds, so nothing
# needs publishing for the console link itself — only the HTTP API.
EXPOSE 3000
USER node

CMD ["node", "dist/main.js"]
