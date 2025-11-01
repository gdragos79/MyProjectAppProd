Awesome—here’s a **from-zero, step-by-step** guide to set up **autostart** for your **Production (Blue & Green) VMs** and the **Staging VM**, using the **same patterns** as in your proxy guide (systemd unit + `docker compose up -d` / `down`). I also include the **encrypted env** flow you’ve been using (`systemd-creds`) so secrets stay at rest in an encrypted blob and are only decrypted into RAM at start time. Where relevant, I point back to the same style used in your Proxy .md (Type=oneshot, WorkingDirectory, enable service, test, etc.). 

---

# Prereqs (run on each VM)

```bash
# 0) You have Docker + Compose v2 installed
docker --version
docker compose version

# 1) Create a place for your stack files
#    (paths below match what you already use)
# PRODUCTION (Blue/Green VMs)
sudo mkdir -p /home/gdragos/app
sudo chown -R $USER:$USER /home/gdragos/app

# STAGING VM
sudo mkdir -p /opt/app-staging
sudo chown -R $USER:$USER /opt/app-staging

# 2) Confirm your compose files exist at:
#    - /home/gdragos/app/docker-compose.yml  (on Blue, on Green)
#    - /opt/app-staging/docker-compose.yml   (on Staging)
```

> In your proxy guide you used this exact **systemd unit layout** with Docker Compose (`Type=oneshot`, `WorkingDirectory`, `ExecStart/ExecStop`, `RemainAfterExit=yes`)—we’ll mirror that here. 

---

# A) Production VM autostart (do this on **Blue** and then on **Green**)

> Uses **encrypted env** at `/etc/credstore.encrypted/app.env`, and a **systemd** unit named `myproject-app.service` that decrypts into `/run/credentials/myproject-app.service/app.env` before starting Compose.

## A1) Create the encrypted env (no plaintext left on disk)

```bash
# Make the encrypted-cred store (root-only)
sudo install -d -m 700 /etc/credstore.encrypted

# Encrypt from stdin (older systemd uses positional args: encrypt <OUTPUT> <INPUT>)
sudo systemd-creds encrypt /etc/credstore.encrypted/app.env - <<'ENV'
# Image tag you want live on this VM
TAG=latest

# App DB creds (prod)
DB_HOST=192.168.238.137
DB_PORT=5432
DB_USER=myapp_prod
DB_PASSWORD=change_me
DB_NAME=myapp_prod_db

# Frontend runtime (if your FE reads it)
VITE_API_BASE_URL=/api
ENV

# (Optional) peek decrypted (root) without writing plaintext to disk
sudo systemd-creds cat /etc/credstore.encrypted/app.env | sed 's/DB_PASSWORD=.*/DB_PASSWORD=******/'
```

> If your `systemd-creds` supports `-o`, you may use `-o <file>`—but the **positional form above** is compatible with older releases (you hit this earlier).

## A2) Make sure your compose references env vars

In `/home/gdragos/app/docker-compose.yml`, **do not** use `env_file:` here; we’ll pass `--env-file` from systemd. Ensure services read variables via `environment:` with `${…}`:

```yaml
# /home/gdragos/app/docker-compose.yml  (Prod)
services:
  backend:
    image: ghcr.io/OWNER/REPO-backend:${TAG:-latest}
    restart: unless-stopped
    environment:
      DB_HOST: ${DB_HOST}
      DB_PORT: ${DB_PORT}
      DB_USER: ${DB_USER}
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: ${DB_NAME}
    ports: ["3000:3000"]   # example; keep whatever you already expose
  frontend:
    image: ghcr.io/OWNER/REPO-frontend:${TAG:-latest}
    restart: unless-stopped
    environment:
      VITE_API_BASE_URL: ${VITE_API_BASE_URL}
    ports: ["80:80"]
```

## A3) Create the **systemd** service (same style as your proxy unit)

```bash
# /etc/systemd/system/myproject-app.service
sudo tee /etc/systemd/system/myproject-app.service >/dev/null <<'UNIT'
[Unit]
Description=MyProject App Stack (Blue/Green)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/home/gdragos/app

# Decrypts into: /run/credentials/myproject-app.service/app.env
LoadCredentialEncrypted=app.env:/etc/credstore.encrypted/app.env

ExecStart=/usr/bin/docker compose \
  --env-file /run/credentials/myproject-app.service/app.env \
  -f /home/gdragos/app/docker-compose.yml up -d

ExecStop=/usr/bin/docker compose \
  --env-file /run/credentials/myproject-app.service/app.env \
  -f /home/gdragos/app/docker-compose.yml down

RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
```

> This mirrors the **oneshot + WorkingDirectory + up/down** pattern you used in the proxy guide. 

## A4) Enable & start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now myproject-app
systemctl status myproject-app --no-pager

# See containers / ports
docker compose -f /home/gdragos/app/docker-compose.yml ps
```

## A5) Verify the app on the VM

```bash
# Backend health (adjust path if different)
curl -is http://127.0.0.1:3000/healthz | head -1
# Frontend
curl -is http://127.0.0.1/ | head -1
```

> You already know how to route Blue/Green at the proxy. Flip at the proxy by swapping `active.conf` symlink, validate with `nginx -t` and reload—same steps as in your doc. 

---

# B) Staging VM autostart

> Same idea, different paths + (optionally) different variable names. I’ll show both **standard names** and how to keep your `_STAGING` suffixes if you prefer them.

## B1) Create the encrypted env on **Staging**

**Variant 1 — standard names:**

```bash
sudo install -d -m 700 /etc/credstore.encrypted

sudo systemd-creds encrypt /etc/credstore.encrypted/app-staging.env - <<'ENV'
TAG=latest
DB_HOST=192.168.238.137
DB_PORT=5432
DB_USER=deploy
DB_PASSWORD=password1234
DB_NAME=myappstagingdb
VITE_API_BASE_URL=/api
ENV
```

**Variant 2 — keep your `_STAGING` names (works too):**

```bash
sudo systemd-creds encrypt /etc/credstore.encrypted/app-staging.env - <<'ENV'
TAG=latest
DB_HOST_STAGING=192.168.238.137
DB_PORT_STAGING=5432
DB_USER_STAGING=deploy
DB_PASSWORD_STAGING=password1234
DB_NAME_STAGING=myappstagingdb
VITE_API_BASE_URL=/api
ENV
```

## B2) Compose on Staging must **read** those envs

* If you used **standard names**:

```yaml
# /opt/app-staging/docker-compose.yml
services:
  backend:
    image: ghcr.io/OWNER/REPO-backend:${TAG:-latest}
    restart: unless-stopped
    environment:
      NODE_ENV: "staging"
      DB_HOST: ${DB_HOST}
      DB_PORT: ${DB_PORT}
      DB_USER: ${DB_USER}
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: ${DB_NAME}
    ports: ["3001:3000"]
  frontend:
    image: ghcr.io/OWNER/REPO-frontend:${TAG:-latest}
    restart: unless-stopped
    depends_on:
      backend:
        condition: service_healthy
    environment:
      VITE_API_BASE_URL: ${VITE_API_BASE_URL}
    ports: ["8081:80"]
```

* If you **kept `_STAGING`**:

```yaml
environment:
  DB_HOST: ${DB_HOST_STAGING}
  DB_PORT: ${DB_PORT_STAGING}
  DB_USER: ${DB_USER_STAGING}
  DB_PASSWORD: ${DB_PASSWORD_STAGING}
  DB_NAME: ${DB_NAME_STAGING}
```

*(Do **not** add `env_file:`—the unit will pass the env.)*

## B3) Create the Staging **systemd** service

```bash
# /etc/systemd/system/app-staging.service
sudo tee /etc/systemd/system/app-staging.service >/dev/null <<'UNIT'
[Unit]
Description=MyProject App Staging (Docker Compose + encrypted env)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/app-staging
RemainAfterExit=yes

# Decrypts into: /run/credentials/app-staging.service/app.env
LoadCredentialEncrypted=app.env:/etc/credstore.encrypted/app-staging.env

ExecStart=/usr/bin/docker compose \
  --env-file /run/credentials/app-staging.service/app.env \
  -f /opt/app-staging/docker-compose.yml up -d

ExecStop=/usr/bin/docker compose \
  --env-file /run/credentials/app-staging.service/app.env \
  -f /opt/app-staging/docker-compose.yml down

[Install]
WantedBy=multi-user.target
UNIT
```

## B4) Enable & start Staging

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now app-staging
systemctl status app-staging --no-pager
docker compose -f /opt/app-staging/docker-compose.yml ps
```

## B5) Verify locally and through the Proxy

**On Staging VM:**

```bash
curl -is http://127.0.0.1:3001/healthz | head -1
curl -is http://127.0.0.1:8081/ | head -1
```

**From Proxy VM (replace IP):**

```bash
STAGING_VM_IP=192.168.238.144
curl -is http://$STAGING_VM_IP:3001/healthz | head -1
curl -is http://$STAGING_VM_IP:8081/ | head -1
```

**Through NGINX on Proxy (Host header)** — same testing pattern you used in your guide:

```bash
# Staging vhost
curl -is http://127.0.0.1/ -H "Host: stage.local" | head -1
curl -is http://127.0.0.1/api/healthz -H "Host: stage.local" | head -1
```

(Ensure your staging server block strips `/api/` when proxying if your backend exposes `/healthz`—exactly like the prod example in your doc where `/api/` is handled with a trailing slash.) 

---

# C) Daily ops you’ll use (all three VMs)

## C1) Check / restart on demand

```bash
# Prod (Blue/Green)
sudo systemctl status myproject-app --no-pager
sudo systemctl restart myproject-app

# Staging
sudo systemctl status app-staging --no-pager
sudo systemctl restart app-staging
```

## C2) Rotate secrets or tag (no plaintext on disk)

```bash
# PRODUCTION (on Blue or on Green)
sudo systemd-creds encrypt /etc/credstore.encrypted/app.env - <<'ENV'
TAG=rel-2025.11.01.001
DB_HOST=...
DB_PORT=...
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
VITE_API_BASE_URL=/api
ENV
sudo systemctl restart myproject-app

# STAGING
sudo systemd-creds encrypt /etc/credstore.encrypted/app-staging.env - <<'ENV'
TAG=rel-2025.11.01.001
DB_HOST=...
DB_PORT=...
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
VITE_API_BASE_URL=/api
ENV
sudo systemctl restart app-staging
```

## C3) Boot behavior

Both services are **enabled** (`enable --now`) and will start automatically after reboots—same as your proxy service in the .md. 

---

# D) (Optional) Proxy flip refresher

Your proxy guide’s Blue/Green flip is still the same:

```bash
cd /etc/nginx/upstreams
sudo ln -sf upstream-green.conf active.conf
sudo nginx -t && sudo systemctl reload nginx
```

You can test with Host header as shown in the guide. 

---

## Troubleshooting quickies

* **`systemd-creds: invalid option -o`** → your build uses the **positional** form: `encrypt <OUTPUT> <INPUT>`; use the heredoc to stdin as shown above.
* **Containers don’t get DB vars** → ensure compose uses `environment:` with `${VAR}`; and that you started via the **systemd unit** that passes `--env-file /run/credentials/.../app.env`.
* **Service path mismatch** → the runtime path includes the **unit name**. If you rename the unit, update the `--env-file` path accordingly (or switch to `${CREDENTIALS_DIRECTORY}/app.env` to make it unit-name-agnostic).
* **Proxy returns 404 on `/api/healthz`** → in the staging vhost, use `location /api/ { proxy_pass http://stage_backend/; }` (note the trailing slash) so `/api/...` is stripped, matching a backend `/healthz`. 

---

If you paste your **exact** compose files for Prod & Staging, I’ll check the `environment:` blocks and confirm the minimal variable set each service needs.
