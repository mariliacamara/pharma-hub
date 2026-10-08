# Node 24, the version in .node-version and in CI. A fixed major, so a new
# image never changes the runtime by surprise.
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./

# --ignore-scripts skips the `prepare` script (git hooks), useless in an image.
RUN npm ci --ignore-scripts

COPY . .

# Generates the Prisma client and compiles to dist/.
RUN npm run build

RUN npm prune --omit=dev --ignore-scripts

FROM node:24-alpine AS production

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# The migrations and the Prisma configuration, so the same image can apply
# them before a deploy: `npx prisma migrate deploy`, with
# DATABASE_MIGRATION_URL set for that command only. See README, "Deploying".
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# The image ships an unprivileged user; nothing here needs root.
USER node

CMD ["node", "dist/main.js"]
