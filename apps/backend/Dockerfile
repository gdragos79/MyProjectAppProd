# syntax=docker/dockerfile:1

# --- Base image
FROM node:20-alpine AS base
WORKDIR /app

# --- Install dependencies using backend's lockfile
FROM base AS deps
# copy ONLY backend's manifest files
COPY backend/package*.json ./
RUN npm ci

# --- Runtime image
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prisma engines & many libs need openssl on Alpine
RUN apk add --no-cache openssl

# bring in deps first for better layer caching
COPY --from=deps /app/node_modules ./node_modules

# copy the backend source into the image
COPY backend/. .

# generate prisma client if present; no-op otherwise
RUN npx prisma generate || true

# adjust if your backend listens on a different port
ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
