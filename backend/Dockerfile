# -------- base image
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# -------- deps: install prod deps using lockfile if present
FROM base AS deps
# copy only package files first for better layer caching
COPY package*.json ./
# install only production deps (omit dev)
RUN npm ci --omit=dev

# -------- runtime image
FROM base AS runtime
# optional: curl for healthcheck
RUN apk add --no-cache curl
# copy node_modules from deps
COPY --from=deps /app/node_modules ./node_modules
# now copy the backend source (context is ./backend)
COPY . .

# the app listens on 3000 (see index.js)
EXPOSE 3000

# lightweight healthcheck hitting your /api/health endpoint
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1

# default command
CMD ["npm","start"]
