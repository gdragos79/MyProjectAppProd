# Autostart (systemd) for **Staging** and **Production** VMs

This guide sets up **systemd + encrypted env** to auto-start your 2-service stack (backend + frontend) via **Docker Compose** after boot, with clean restarts and safe secret handling.

---

## 0) Prerequisites (one time per VM)

```bash
# Ubuntu 22.04/24.04 OK (systemd >= 249)
docker --version
docker compose version
id -u  # run as a sudoer (e.g., gdragos or root)

# Optional but recommended (GHCR pull for private images)
# PAT needs scope: read:packages
echo '<GHCR_PAT>' | sudo docker login ghcr.io -u 'gdragos79' --password-stdin
```

---

## 1) Directory layout & Compose files

We’ll keep environment-specific folders:

```bash
# STAGING
sudo mkdir -p /opt/app-staging
# PRODUCTION
sudo mkdir -p /opt/app-production
```

### 1.1 Staging: `/opt/app-staging/docker-compose.yml`

> Ports: backend **3001→3000**, frontend **8081→80**.
> Uses the **STAGING-suffixed** vars (matches your current Compose).

```yaml
name: myprojectappstg
services:
  backend:
    image: ghcr.io/gdragos79/myprojectapp-backend:${TAG:-latest}
    restart: unless-stopped
    ports: ["3001:3000"]
    environment:
      - DB_HOST=${DB_HOST_STAGING}
      - DB_PORT=${DB_PORT_STAGING}
      - DB_USER=${DB_USER_STAGING}
      - DB_PASSWORD=${DB_PASSWORD_STAGING}
      - DB_NAME=${DB_NAME_STAGING}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/healthz"]
      interval: 10s
      timeout: 2s
      retries: 10

  frontend:
    image: ghcr.io/gdragos79/myprojectapp-frontend:${TAG:-latest}
    restart: unless-stopped
    depends_on:
      backend:
        condition: service_healthy
    ports: ["8081:80"]
    environment:
      - VITE_API_BASE_URL=${VITE_API_BASE_URL}
```

### 1.2 Production: `/opt/app-production/docker-compose.yml`

> Ports: backend **3000→3000**, frontend **8080→80**.
> Uses **PROD-suffixed** vars (or adapt to your existing naming).

```yaml
name: myprojectappprod
services:
  backend:
    image: ghcr.io/gdragos79/myprojectapp-backend:${TAG:-latest}
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      - DB_HOST=${DB_HOST_PROD}
      - DB_PORT=${DB_PORT_PROD}
      - DB_USER=${DB_USER_PROD}
      - DB_PASSWORD=${DB_PASSWORD_PROD}
      - DB_NAME=${DB_NAME_PROD}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/healthz"]
      interval: 10s
      timeout: 2s
      retries: 10

  frontend:
    image: ghcr.io/gdragos79/myprojectapp-frontend:${TAG:-latest}
    restart: unless-stopped
    depends_on:
      backend:
        condition: service_healthy
    ports: ["8080:80"]
    environment:
      - VITE_API_BASE_URL=${VITE_API_BASE_URL}
```

> **Note:** If your backend health endpoint differs, change `/api/healthz` accordingly.

---

## 2) Create **encrypted env** with `systemd-creds`

We’ll embed a single encrypted file per VM and let systemd mount it at runtime.

### 2.1 Staging env → `/etc/credstore.encrypted/app-staging.env`

```bash
# Create a secure temp file
tmpfile=$(mktemp /tmp/app_staging.XXXXXX.env); umask 077
cat > "$tmpfile" <<'ENV'
TAG=latest
DB_HOST_STAGING=192.168.238.137
DB_PORT_STAGING=5432
DB_USER_STAGING=deploy
DB_PASSWORD_STAGING=password1234
DB_NAME_STAGING=myappstagingdb
VITE_API_BASE_URL=/api
ENV

# Ensure credstore dir exists
sudo install -d -m 700 /etc/credstore.encrypted

# Encrypt (LEFT side name must match what unit will reference!)
sudo systemd-creds encrypt --name=app-staging.env "$tmpfile" /etc/credstore.encrypted/app-staging.env
sudo chmod 600 /etc/credstore.encrypted/app-staging.env
shred -u "$tmpfile"

# Sanity check (password masked for display)
sudo systemd-creds decrypt /etc/credstore.encrypted/app-staging.env /dev/stdout \
 | sed -e 's/DB_PASSWORD_STAGING=.*/DB_PASSWORD_STAGING=******/'
```

### 2.2 Production env → `/etc/credstore.encrypted/app-production.env`

```bash
tmpfile=$(mktemp /tmp/app_production.XXXXXX.env); umask 077
cat > "$tmpfile" <<'ENV'
TAG=latest
DB_HOST_PROD=10.0.0.10
DB_PORT_PROD=5432
DB_USER_PROD=deploy
DB_PASSWORD_PROD=change-me
DB_NAME_PROD=myappproddb
VITE_API_BASE_URL=/api
ENV

sudo install -d -m 700 /etc/credstore.encrypted
sudo systemd-creds encrypt --name=app-production.env "$tmpfile" /etc/credstore.encrypted/app-production.env
sudo chmod 600 /etc/credstore.encrypted/app-production.env
shred -u "$tmpfile"

sudo systemd-creds decrypt /etc/credstore.encrypted/app-production.env /dev/stdout \
 | sed -e 's/DB_PASSWORD_PROD=.*/DB_PASSWORD_PROD=******/'
```

> **Important:** The `--name=` you use at **encrypt** time must match the left side of `LoadCredentialEncrypted=` in the unit.

---

## 3) systemd units (autostart)

### 3.1 **Staging** unit: `/etc/systemd/system/app-staging.service`

```bash
sudo tee /etc/systemd/system/app-staging.service >/dev/null <<'UNIT'
[Unit]
Description=MyProject App Staging (Docker Compose + encrypted env)
Wants=network-online.target
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/app-staging

# LEFT NAME must match --name used at encrypt time
LoadCredentialEncrypted=app-staging.env:/etc/credstore.encrypted/app-staging.env

# Bring down leftovers
ExecStartPre=/usr/bin/docker compose -f /opt/app-staging/docker-compose.yml down --remove-orphans

# NOTE: include .service in the runtime path!
ExecStart=/usr/bin/docker compose --env-file /run/credentials/app-staging.service/app-staging.env -f /opt/app-staging/docker-compose.yml up -d

# Stop path
ExecStop=/usr/bin/docker compose -f /opt/app-staging/docker-compose.yml down

TimeoutStartSec=180
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
```

### 3.2 **Production** unit: `/etc/systemd/system/app-production.service`

```bash
sudo tee /etc/systemd/system/app-production.service >/dev/null <<'UNIT'
[Unit]
Description=MyProject App Production (Docker Compose + encrypted env)
Wants=network-online.target
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/app-production

LoadCredentialEncrypted=app-production.env:/etc/credstore.encrypted/app-production.env

ExecStartPre=/usr/bin/docker compose -f /opt/app-production/docker-compose.yml down --remove-orphans
ExecStart=/usr/bin/docker compose --env-file /run/credentials/app-production.service/app-production.env -f /opt/app-production/docker-compose.yml up -d
ExecStop=/usr/bin/docker compose -f /opt/app-production/docker-compose.yml down

TimeoutStartSec=180
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
```

---

## 4) Enable autostart and start the stacks

```bash
# STAGING
sudo systemctl daemon-reload
sudo systemctl enable --now app-staging
systemctl status app-staging --no-pager

# PRODUCTION
sudo systemctl daemon-reload
sudo systemctl enable --now app-production
systemctl status app-production --no-pager
```

Expected result (staging example):

```
Active: active (exited)
...
Container myprojectappstg-backend-1  Healthy
Container myprojectappstg-frontend-1 Started
```

---

## 5) Verify

### 5.1 Containers & ports

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
# Staging:
# myprojectappstg-backend-1    Up (healthy)   0.0.0.0:3001->3000/tcp
# myprojectappstg-frontend-1   Up             0.0.0.0:8081->80/tcp

# Production:
# myprojectappprod-backend-1   Up (healthy)   0.0.0.0:3000->3000/tcp
# myprojectappprod-frontend-1  Up             0.0.0.0:8080->80/tcp
```

### 5.2 HTTP checks (run on each VM)

```bash
# Backend health (adjust path if needed)
curl -fsS http://127.0.0.1:3001/api/healthz && echo " STAGING backend OK"
curl -I http://127.0.0.1:8081 | head -n1

curl -fsS http://127.0.0.1:3000/api/healthz && echo " PROD backend OK"
curl -I http://127.0.0.1:8080 | head -n1
```

---

## 6) Daily operations

### Pull new images & restart (per VM)

```bash
# Staging
sudo systemctl stop app-staging
sudo docker compose -f /opt/app-staging/docker-compose.yml pull
sudo systemctl start app-staging

# Production
sudo systemctl stop app-production
sudo docker compose -f /opt/app-production/docker-compose.yml pull
sudo systemctl start app-production
```

### Rotate secrets

```bash
# Recreate the temp file with new values, then:
sudo systemd-creds encrypt --name=app-staging.env /tmp/new.env /etc/credstore.encrypted/app-staging.env
sudo systemctl restart app-staging

sudo systemd-creds encrypt --name=app-production.env /tmp/new.env /etc/credstore.encrypted/app-production.env
sudo systemctl restart app-production
```

---

## 7) Troubleshooting (quick checklist)

* **“couldn’t find env file: /run/credentials/…”**
  Use the **.service suffix** in ExecStart:
  `/run/credentials/app-staging.service/app-staging.env`

* **“Embedded credential name … does not match filename …”**
  The left side of `LoadCredentialEncrypted=` **must equal** the `--name=` used at encrypt time.

* **Variables show as “Defaulting to blank string”**
  The env file wasn’t mounted/read. Double-check the runtime path and `LoadCredentialEncrypted` name.

* **GHCR “manifest unknown” / “denied”**

  * Log in with a PAT that has `read:packages`.
  * Ensure images `ghcr.io/gdragos79/myprojectapp-frontend:latest` and `...-backend:latest` exist.

* **Port already allocated**
  Stop old containers/networks before starting:

  ```bash
  docker ps -a --filter "name=myprojectappstg|app-staging|myprojectappprod|app-production" -q | xargs -r docker rm -f
  docker network ls --format '{{.ID}}\t{{.Name}}' | egrep 'app-staging|myprojectappstg|app-production|myprojectappprod' \
   | awk '{print $1}' | xargs -r docker network rm
  ```

* **Where are creds at runtime?**
  They exist **only during ExecStart/Stop** under `/run/credentials/<unit>.service/`.

---

## 8) Safe removal

```bash
# Staging
sudo systemctl disable --now app-staging
sudo rm -f /etc/systemd/system/app-staging.service
sudo rm -f /etc/credstore.encrypted/app-staging.env

# Production
sudo systemctl disable --now app-production
sudo rm -f /etc/systemd/system/app-production.service
sudo rm -f /etc/credstore.encrypted/app-production.env

sudo systemctl daemon-reload
```

---

You’re set. This mirrors the exact working pattern from your staging VM (including the fixed runtime path and the `[Install]` section) and extends it cleanly to production.
