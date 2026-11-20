# ---- Build stage ----
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# ---- Production stage ----
FROM node:24-alpine AS runner

# Prisma's engines need OpenSSL, which the alpine base image does not ship.
RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
# prisma is a devDependency; install the locked version so the release step can run
# `npx prisma migrate deploy` without npx fetching an incompatible latest CLI.
RUN npm ci --omit=dev \
  && npm install --no-save --omit=dev "prisma@$(node -p "require('./package-lock.json').packages['node_modules/prisma'].version")" \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY prisma ./prisma
COPY prisma.config.ts ./

# The app writes schema.gql and logs/ at runtime; nothing else under /app is writable by it.
COPY --chown=node:node schema.gql ./
RUN mkdir logs && chown node:node logs

USER node

EXPOSE 3000

# One image, two processes: ROLE=api (default) serves GraphQL/REST; ROLE=worker runs the outbox relay and queue
# processors and serves only /health/live and /health/ready on PORT, so this check fits both.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "dist/main.js"]
