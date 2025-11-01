# syntax=docker/dockerfile:1

# Base image
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

# Install dependencies separately for caching
FROM base AS deps
COPY package*.json ./
# Use full install; we will run `node index.js` (no nodemon required)
RUN npm ci

# Runtime image
FROM base AS runtime
ENV NODE_ENV=production
# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
# Copy app source (from apps/backend context)
COPY . .

# Expose the backend port
EXPOSE 3000

# Start the server directly with Node (avoids needing dev deps like nodemon)
CMD ["node", "index.js"]
