# -------- builder: compile React app
FROM node:20-alpine AS builder
WORKDIR /app

# Let Vite embed the API base at build-time.
# Your code reads import.meta.env.VITE_API_BASE (NOT _BASE_URL).
# You can override this with a build-arg in CI if needed.
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE

# install deps with cache-friendly layering
COPY package*.json ./
RUN npm ci

# copy sources and build
COPY . .
RUN npm run build

# -------- runtime: NGINX to serve /usr/share/nginx/html
FROM nginx:1.27-alpine AS runtime

# copy build output
COPY --from=builder /app/dist /usr/share/nginx/html

# minimal SPA config + /api proxy to the backend service in Compose (backend:3000)
# Uses Dockerfile heredoc (supported by buildx/dockerfile v1)
RUN <<'NGINX' cat > /etc/nginx/conf.d/default.conf
server {
  listen 80;
  server_name _;

  # serve static SPA
  root /usr/share/nginx/html;
  index index.html;

  # cache headers for static assets
  location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$ {
    try_files $uri =404;
    access_log off;
  }

  # SPA fallback
  location / {
    try_files $uri $uri/ /index.html;
  }

  # proxy API to backend service (Compose service name: "backend")
  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://backend:3000;
  }
}
NGINX

EXPOSE 80
