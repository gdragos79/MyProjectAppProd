
# How nginx finds `/etc/nginx/upstreams/active.conf`

nginx loads its main config `/etc/nginx/nginx.conf`, which **includes** either:

* `include /etc/nginx/conf.d/*.conf;` (the **conf.d layout**), or
* `include /etc/nginx/sites-enabled/*;` (the **sites-available/sites-enabled layout**).

Inside your site’s config (e.g., `/etc/nginx/conf.d/site.conf` or `/etc/nginx/sites-available/myproject.conf`) you add:

```nginx
include /etc/nginx/upstreams/active.conf;
```

That single line is how nginx “knows” to look in `/etc/nginx/upstreams/`.

---

## Quick check: which layout do you have?

```bash
# Show top-level includes
sudo nginx -T | grep -E "include .*conf\.d|include .*sites-enabled" -n
```

You’ll see one or both:

* `include /etc/nginx/conf.d/*.conf;`
* `include /etc/nginx/sites-enabled/*;`

Use the matching setup below.

---

# Option 1 — **conf.d** layout (simple)USED CURRENTLY!!

### 1) Create upstreams directory + color files + active symlink

```bash
# Replace with your real LAN IPs
BLUE_IP="192.168.X.BLUE"
GREEN_IP="192.168.X.GREEN"

sudo mkdir -p /etc/nginx/upstreams

# BLUE (defines BOTH upstreams: :80 frontend, :3000 backend)
sudo tee /etc/nginx/upstreams/upstream-blue.conf >/dev/null <<EOF
upstream app_frontend {
  server ${BLUE_IP}:80  max_fails=3 fail_timeout=5s;
  keepalive 32;
}
upstream app_backend {
  server ${BLUE_IP}:3000 max_fails=3 fail_timeout=5s;
  keepalive 32;
}
EOF

# GREEN
sudo tee /etc/nginx/upstreams/upstream-green.conf >/dev/null <<EOF
upstream app_frontend {
  server ${GREEN_IP}:80  max_fails=3 fail_timeout=5s;
  keepalive 32;
}
upstream app_backend {
  server ${GREEN_IP}:3000 max_fails=3 fail_timeout=5s;
  keepalive 32;
}
EOF

# Make BLUE active initially
cd /etc/nginx/upstreams
sudo ln -sf upstream-blue.conf active.conf
```

### 2) Create the site file that includes `active.conf`

```bash
sudo tee /etc/nginx/conf.d/site.conf >/dev/null <<'EOF'
# Pulls in either upstream-blue.conf or upstream-green.conf via active.conf
include /etc/nginx/upstreams/active.conf;

server {
  listen 80;
  server_name _;

  client_max_body_size 10m;
  proxy_read_timeout 60s;

  # Frontend → app_frontend (:80)
  location / {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://app_frontend;
  }

  # API → app_backend (:3000)
  # NOTE the trailing slash to strip /api/ when proxying to backend
  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://app_backend/get;
  }

  # Optional exact health shortcut
  location = /api/healthz {
    proxy_pass http://app_backend/healthz;
  }
}
EOF
```

### 3) Remove default site (prevents catch-all conflicts)

```bash
[ -e /etc/nginx/sites-enabled/default ] && sudo unlink /etc/nginx/sites-enabled/default || true
```

### 4) Validate and reload

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 5) Test through the native nginx

```bash
curl -I  http://127.0.0.1/                      # expect 200 (frontend)
curl -is http://127.0.0.1/api/healthz | head -1 # expect 200 (backend /healthz)
```

### 6) Flip Blue ↔ Green (zero-downtime)

```bash
cd /etc/nginx/upstreams
sudo ln -sf upstream-green.conf active.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

# Option 2 — **sites-available / sites-enabled** layout (Ubuntu/Debian style)NOT USED CURRENTLY!!!

### 1) Upstreams (same as above)

Use **exactly** the same commands from **Option 1 → Step 1** to create:

* `/etc/nginx/upstreams/upstream-blue.conf`
* `/etc/nginx/upstreams/upstream-green.conf`
* `/etc/nginx/upstreams/active.conf` (symlink)

### 2) Create the site in `sites-available` and enable it

```bash
sudo tee /etc/nginx/sites-available/myproject.conf >/dev/null <<'EOF'
include /etc/nginx/upstreams/active.conf;

server {
  listen 80;
  server_name _;

  client_max_body_size 10m;
  proxy_read_timeout 60s;

  location / {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://app_frontend;
  }

  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://app_backend/;
  }

  location = /api/healthz {
    proxy_pass http://app_backend/healthz;
  }
}
EOF

# Enable the site and disable the default
sudo ln -sf /etc/nginx/sites-available/myproject.conf /etc/nginx/sites-enabled/myproject.conf
[ -e /etc/nginx/sites-enabled/default ] && sudo unlink /etc/nginx/sites-enabled/default || true
```

### 3) Validate and reload

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 4) Test

```bash
curl -I  http://127.0.0.1/
curl -is http://127.0.0.1/api/healthz | head -1
```

### 5) Flip Blue ↔ Green

```bash
cd /etc/nginx/upstreams
sudo ln -sf upstream-green.conf active.conf
sudo nginx -t && sudo systemctl reload nginx
```

##########################################################
#Autostart on boot (systemd unit)
sudo tee /etc/systemd/system/myproject-proxy.service >/dev/null <<'UNIT'
[Unit]
Description=MyProject Proxy Stack (NGINX in Docker)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/home/gdragos/proxy
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now myproject-proxy
######################################################
#Flip manually (handy for testing)
# To GREEN
cd /home/gdragos/proxy/nginx/upstreams
ln -sfn ../upstream-green.conf active.conf
echo "green" | sudo tee /var/lib/myproject/live_color
cd /home/gdragos/proxy && docker compose exec proxy nginx -s reload

# Back to BLUE
cd /home/gdragos/proxy/nginx/upstreams
ln -sfn ../upstream-blue.conf active.conf
echo "blue" | sudo tee /var/lib/myproject/live_color
cd /home/gdragos/proxy && docker compose exec proxy nginx -s reload
########################################################
