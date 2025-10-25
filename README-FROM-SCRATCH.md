# MyProjectAppProd — From-Scratch Implementation Guide (Blue/Green • Single DB • GitHub Actions)

This guide brings you from a clean set of VMs to a working **blue/green** deployment with a **single Postgres DB**, using **GitHub Actions** CI/CD, **GHCR** images, and an **NGINX Proxy VM** that flips traffic between colors.

---

## 0) Plan & prerequisites

### Topology (all VMs on the same LAN)
- **Proxy VM** (public entry point on port 80; flips between blue/green)
- **Blue App VM** (frontend + backend)
- **Green App VM** (frontend + backend)
- **DB VM** (PostgreSQL; single shared database)

### Accounts & tools
- GitHub repo (monorepo with `./backend` and `./react`)
- GitHub Environments: **development**, **staging**, **production**
- A **PAT** for GHCR with `read:packages`
- SSH access to all VMs as user `gdragos` (adjust paths/usernames if different)

### Required ports & firewall (UFW examples)
```bash
# Proxy VM (public)
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp

# App VMs (Blue & Green) – allow only from Proxy VM to port 80; SSH from your IP
sudo ufw allow 22/tcp
sudo ufw allow from <PROXY_VM_LAN_IP> to any port 80 proto tcp

# DB VM – allow only from Blue/Green to 5432
sudo ufw allow 22/tcp
sudo ufw allow from <BLUE_VM_LAN_IP> to any port 5432 proto tcp
sudo ufw allow from <GREEN_VM_LAN_IP> to any port 5432 proto tcp

sudo ufw enable
```

> **Security note:** Do **not** expose Postgres to the internet. Keep it LAN-only.

---

## 1) Install Docker & compose on each VM

### Ubuntu quick install
```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker gdragos
newgrp docker
docker version
docker compose version
```

---

## 2) Prepare the Proxy VM

### 2.1. Copy the proxy files
Copy the `proxy/` folder from this bundle to `/home/gdragos/proxy/` on the **Proxy VM**.

File layout:
```
/home/gdragos/proxy/
  docker-compose.yml
  nginx/
    site.conf
    upstreams/
      active.conf        # <- symlink to ../upstream-blue.conf or ../upstream-green.conf
    upstream-blue.conf   # <- edit BLUE_VM_IP placeholder
    upstream-green.conf  # <- edit GREEN_VM_IP placeholder
```

Edit **`nginx/upstream-blue.conf`** and **`nginx/upstream-green.conf`** and set LAN IPs:
```nginx
# upstream-blue.conf
upstream app_upstream { server 192.168.1.21:80; keepalive 32; }  # Blue VM IP

# upstream-green.conf
upstream app_upstream { server 192.168.1.22:80; keepalive 32; }  # Green VM IP
```

Create the active symlink and start:
```bash
cd /home/gdragos/proxy/nginx/upstreams
ln -sfn ../upstream-blue.conf active.conf   # default live = blue
cd /home/gdragos/proxy
docker compose up -d
```

> The CI/CD will flip by switching `active.conf` to the other file and reloading NGINX.

### 2.2. Persist live color state (for CI/CD)
Create a state file on the Proxy VM:
```bash
sudo mkdir -p /var/lib/myproject
echo "blue" | sudo tee /var/lib/myproject/live_color
```

### 2.3. (MUST!!!Dependent on 3.2) Autostart via systemd
Copy `systemd/myproject-proxy.service` to `/etc/systemd/system/` on the Proxy VM, then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now myproject-proxy
```

---

## 3) Prepare each App VM (Blue and Green)

### 3.1. Create app directory and compose
Copy `deploy/docker-compose.yml` to `/home/gdragos/app/docker-compose.yml` on **both** App VMs.

This compose expects the following environment variables at runtime:
- `TAG` (image tag to run)
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- It publishes frontend on **port 80** and backend on **port 3000**.

### 3.2. Autostart via systemd (Tricky!!!!See Autostart vis systemd for a detailed description related also to the security!!)
Copy `systemd/myproject-app.service` to `/etc/systemd/system/` on each App VM:
```bash
sudo mkdir -p /etc/myproject
# (Optional) a local env file if you prefer; otherwise CI exports vars at deploy time:
# sudo tee /etc/myproject/app.env <<EOF
# DB_HOST=192.168.1.30
# DB_PORT=5432
# DB_USER=postgres
# DB_PASSWORD=***
# DB_NAME=mydb
# EOF

sudo systemctl daemon-reload
sudo systemctl enable --now myproject-app
```

> Even with systemd, your CI sets `TAG` and DB vars and runs `docker compose up -d` during deploys.

---

## 4) Database VM (PostgreSQL)

Ensure Postgres listens on the LAN interface and allows **Blue & Green** IPs:
- `postgresql.conf`: `listen_addresses = '*'` (or specific LAN IP)
- `pg_hba.conf` (examples):
  ```
  host  all  all  192.168.1.21/32  md5   # Blue App VM
  host  all  all  192.168.1.22/32  md5   # Green App VM
  ```
Restart Postgres and test from App VM:
```bash
nc -vz <DB_LAN_IP> 5432
```

---

## 5) GitHub setup (GHCR & Secrets)

### 5.1. Create a GHCR token (PAT)
- GitHub → Settings → Developer settings → Personal access tokens  
- Generate a Fine-grained or Classic token with **`read:packages`** (classic scope)  
- Copy it (you won’t see it again).

### 5.2. Environment secrets (for each of Development/Staging/Production)
Add these keys in the corresponding **Environment**:
- `GHCR_USERNAME` = your GitHub username
- `GHCR_TOKEN` = the PAT
- `APP_BLUE_SSH_HOST`, `APP_BLUE_SSH_USER`, `APP_BLUE_SSH_KEY`
- `APP_GREEN_SSH_HOST`, `APP_GREEN_SSH_USER`, `APP_GREEN_SSH_KEY`
- `PROXY_SSH_HOST`, `PROXY_SSH_USER`, `PROXY_SSH_KEY`
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`

> SSH keys: store the **private key** content in `*_SSH_KEY`, and make sure the matching **public key** is in `~/.ssh/authorized_keys` for user `gdragos` on each VM.

---

## 6) Repo files & workflows

From this bundle, add to your repo:
```
.github/workflows/
  deploy_development.yml
  deploy_staging.yml
  deploy_production.yml   # Option A (tag-gated on rel-*)
backend/
  prisma/schema.prisma
```

### Backend health check & Prisma
Apply the provided patches or manually update:
- Add **`GET /healthz`** endpoint (returns 200 OK; optional DB ping).
- Add NPM scripts:
  ```json
  {
    "scripts": {
      "prisma:generate": "prisma generate",
      "migrate": "prisma migrate deploy"
    }
  }
  ```
- Install deps:
  ```bash
  npm -C backend i -D prisma
  npm -C backend i @prisma/client
  ```

---

## 7) CI/CD behavior (what happens on each branch)

### Development
- Trigger: push to `development`
- Actions:
  1. Build/push images tagged `sha-<shortsha>`
  2. Determine idle color from Proxy (reads `/var/lib/myproject/live_color`)
  3. Deploy to idle color App VM, exporting DB env vars
  4. Run **Prisma migrate** (backward-compatible migrations only)
  5. Health-check `GET /healthz` and homepage `/`
  6. Flip Proxy symlink to new color; reload NGINX

### Staging
- Same as Dev, but image tags `stg-<shortsha>` **and** `sha-<shortsha>`.

### Production — **Option A: tag-gated (recommended)**
- Trigger: **push a Git tag** named `rel-YYYY.MM.DD.N` (e.g., `rel-2025.10.17.1`) on a commit that’s part of `main`.
- The workflow checks the tag is **on `main`**, builds/pushes `<rel>`, `sha-<shortsha>`, and `latest`, then does the **same deploy sequence** as Dev/Stg.
- Rollback: rerun the workflow with a **previous rel tag** (create a new tag pointing to an older good commit if needed).

---

## 8) First run / cold start (all VMs were off)

1. **Proxy VM**
   ```bash
   cd /home/gdragos/proxy/nginx/upstreams
   ln -sfn ../upstream-blue.conf active.conf   # if not present
   cd /home/gdragos/proxy && docker compose up -d
   echo "blue" | sudo tee /var/lib/myproject/live_color
   ```

2. **DB VM**: ensure Postgres is running, listening on LAN IP, UFW rules applied.

3. **Live App color (Blue by default)**
   - CI will deploy, or run manually for a first smoke:
     ```bash
     cd /home/gdragos/app
     export TAG=latest DB_HOST=... DB_PORT=5432 DB_USER=... DB_PASSWORD=... DB_NAME=...
     docker compose up -d
     ```

4. **Verify**
   - From Blue App VM:
     ```bash
     curl -fsS http://localhost:3000/healthz
     curl -I http://localhost/
     ```
   - From your browser: `http://<PROXY_VM_IP>/`

---

## 9) Flip, rollback, and migrations

### Flip (manual)
```bash
# On Proxy VM:
cd /home/gdragos/proxy/nginx/upstreams
ln -sfn ../upstream-green.conf active.conf
echo "green" | sudo tee /var/lib/myproject/live_color
cd /home/gdragos/proxy && docker compose exec proxy nginx -s reload
```

### Rollback
```bash
# Switch back the symlink and reload NGINX
ln -sfn ../upstream-blue.conf active.conf
echo "blue" | sudo tee /var/lib/myproject/live_color
docker compose exec proxy nginx -s reload
```

### Migrations policy
- Use **expand → migrate → contract**. All code must work with **old + new** schema during the overlap.
- Workflows run `prisma migrate deploy` **before** the flip; if it fails, the flip is **aborted**.

---

## 10) Troubleshooting

- **Compose: no configuration file provided** → ensure `/home/gdragos/app/docker-compose.yml` exists on App VMs; `/home/gdragos/proxy/docker-compose.yml` on Proxy VM.
- **Container name conflict** → our compose has **no** `container_name` set (Option C). If you still see conflicts, remove old containers: `docker rm -f frontend backend`.
- **GHCR pull denied** → confirm `GHCR_USERNAME` & `GHCR_TOKEN` secrets and that the workflow ran `docker login ghcr.io`.
- **DB connection errors** → verify LAN IP, `pg_hba.conf`, and UFW rules allowing App VMs to 5432.
- **Health check fails** → `docker logs $(docker ps -qf name=backend)` and confirm `/healthz` route exists.
- **Proxy not flipping** → ensure `nginx/upstreams/active.conf` points to the correct color and reload NGINX inside the **container**.

---

## 11) Optional hardening & improvements
- Add TLS (Let’s Encrypt) on Proxy VM (port 443)
- Add Prometheus + Grafana or simple uptime checks
- Add container log shipping
- Database backups & PITR

---

## 12) Quick reference

**Repo layout (CI/CD artifacts)**
```
.github/workflows/
  deploy_development.yml
  deploy_staging.yml
  deploy_production.yml   # tag-gated Option A
backend/
  prisma/schema.prisma
```

**VM paths**
```
Proxy VM: /home/gdragos/proxy
App VM : /home/gdragos/app
State   : /var/lib/myproject/live_color
```


# Self-hosted GitHub Actions Runner (LAN)

## Why use a self-hosted runner?
- Use **private LAN IPs** for SSH to Blue/Green/Proxy (no public exposure, no port-forwarding).
- Faster and more reliable internal network access.

## Where to run it
Use any always-on Linux VM in the same LAN (Proxy VM or a small utility VM works).

## Install Docker on the runner VM
```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
docker version && docker compose version
```

## Install & register the runner
1. GitHub → Repository → **Settings → Actions → Runners → New self-hosted runner → Linux**.
2. Run the generated commands (version and token will be pre-filled), e.g.:
```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o actions-runner-linux-x64-<ver>.tar.gz -L https://github.com/actions/runner/releases/download/v<ver>/actions-runner-linux-x64-<ver>.tar.gz
tar xzf actions-runner-linux-x64-<ver>.tar.gz
./config.sh --url https://github.com/<owner>/<repo> --token <runner_token> --labels self-hosted,linux,lan
sudo ./svc.sh install
sudo ./svc.sh start
```
3. Verify it shows **Online** in the repo’s Runners list.

## Update workflows to target the LAN runner
Change each job header to:
```yaml
runs-on: [self-hosted, linux, lan]
```
Files updated in this package:
- `.github/workflows/deploy_development.yml`
- `.github/workflows/deploy_staging.yml`
- `.github/workflows/deploy_production.yml`
- `.github/workflows/runner_ping.yml` (optional)

## SSH host secrets (now private IPs)
Set these on each **Environment** (Development/Staging/Production):
- `APP_BLUE_SSH_HOST = 192.168.X.BLUE`
- `APP_GREEN_SSH_HOST = 192.168.X.GREEN`
- `PROXY_SSH_HOST = 192.168.X.PROXY`
- `*_SSH_USER = gdragos`
- `*_SSH_KEY = <private key content>`

Ports: default to `22` (no need to expose public ports).

## Database secrets (unchanged)
- `DB_HOST = 192.168.X.DB`
- `DB_PORT = 5432`
- `DB_USER`, `DB_PASSWORD`, `DB_NAME`
Ensure Postgres `pg_hba.conf` allows Blue & Green IPs.

## Optional: runner health ping workflow
A simple scheduled job is included at `.github/workflows/runner_ping.yml`.
