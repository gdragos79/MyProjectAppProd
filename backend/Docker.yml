# syntax=docker/dockerfile:1

# --- Base image for consistent paths
FROM node:20-alpine AS base
WORKDIR /app

# --- Install dependencies (keeps cache)
FROM base AS deps
COPY package*.json ./
RUN npm ci

# --- Runtime image
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# prisma engines need openssl on Alpine
RUN apk add --no-cache openssl

# Bring in node_modules and the app source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# If you use Prisma, generate client (no-op if no schema)
RUN npx prisma generate || true

# Configure port and start command (adjust if different)
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]
