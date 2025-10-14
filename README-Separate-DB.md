# Run the database on a separate VM (beginner-friendly guide)

This package refactors your original `dockerize-react-node-postgres-nginx-application` so the **DB runs on its own VM**, while **frontend + backend + Nginx** run on a separate **App VM**.

## Folder map

```
.
├─ docker-compose.app.yml     # App VM: frontend, backend, nginx
├─ backend/                   # Express API (uses env vars for DB)
│  ├─ Dockerfile
│  ├─ index.js
│  ├─ package.json
│  └─ .env.example
├─ react/                     # React UI (Vite dev server)
├─ nginx/
│  ├─ Dockerfile
│  └─ default.conf            # Proxies / -> frontend, /api -> backend
└─ db/                        # DB VM files
   ├─ docker-compose.db.yml   # Postgres with persistent volume
   ├─ db.env.example
   └─ init/
      └─ 02-allow-appvm.sh    # Relaxes pg_hba to allow App VM CIDR
```

---

## 0) Prereqs (do this on **both** VMs)

- Two Linux VMs (e.g., Ubuntu 22.04):
  - **App VM** → runs frontend + backend + nginx
  - **DB VM** → runs Postgres
- Install Docker + Docker Compose Plugin

```
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo   "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg]   https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable"   | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
docker --version
docker compose version
```

**Firewall**  
- On the **DB VM**: allow inbound TCP/5432 **from the App VM only**.
  - If using UFW: `sudo ufw allow from <APP_VM_IP> to any port 5432 proto tcp`

---

## 1) Set up the DB VM

1. Copy the `db/` folder to the DB VM (e.g., to `/opt/separate-db/db`).
2. Create a `db.env` from the example and set strong secrets + your App VM CIDR:
   ```
   cd /opt/separate-db/db
   cp db.env.example db.env
   # Edit with your values:
   # POSTGRES_DB=myappdb
   # POSTGRES_USER=myapp
   # POSTGRES_PASSWORD=<strong password>
   # APP_VM_CIDR=<e.g. 10.0.0.0/24 or your App VM /32>
   ```
3. Start Postgres (first run initializes the data dir and relaxes pg_hba):
   ```
   docker compose -f docker-compose.db.yml up -d
   docker compose -f docker-compose.db.yml ps
   docker compose -f docker-compose.db.yml logs -f
   ```
   Wait until you see `database system is ready to accept connections`.

> **Note:** The first boot scripts only run if the volume is empty.  
> To re-run with new `APP_VM_CIDR`, stop the stack and `docker volume rm <project>_pgdata` (this erases data).

---

## 2) Set up the App VM

1. Copy the **root** of this package to the App VM (e.g., `/opt/separate-db`).
2. Create backend env from example and set DB VM IP + creds:
   ```
   cd /opt/separate-db/backend
   cp .env.example .env
   # Edit .env:
   # DB_HOST=<DB_VM_IP>
   # DB_PORT=5432
   # DB_USER=<from db.env>
   # DB_PASSWORD=<from db.env>
   # DB_NAME=<from db.env>
   ```
3. Start the app stack:
   ```
   cd /opt/separate-db
   docker compose -f docker-compose.app.yml up -d --build
   docker compose -f docker-compose.app.yml ps
   ```
4. Open the site in a browser: `http://<APP_VM_IP>:8000/`
   - **Home** loads the React UI.
   - API routes:
     - Health check → `http://<APP_VM_IP>:8000/api/health`
     - Get all users → `http://<APP_VM_IP>:8000/api/all`
     - Create user (via UI) → Home → Fill form → Submit

---

## 3) Sanity checks

- From App VM, check you can reach DB VM:
  ```
  nc -vz <DB_VM_IP> 5432
  ```
- Check backend logs if API can’t connect:
  ```
  docker logs backend
  ```

---

## 4) Common pitfalls & fixes

- **Connection refused** → DB VM firewall closed. Allow 5432 from App VM.
- **Auth failed** → .env values mismatch between App VM and DB VM.
- **Timeout** → Wrong DB_VM_IP in backend `.env` (or cloud provider security group).
- **Cannot recreate DB rule** → `APP_VM_CIDR` changes only apply on first boot. If needed:
  - Stop DB stack → `docker compose -f db/docker-compose.db.yml down`
  - Remove volume (this ERASES data) → `docker volume ls` → remove the `pgdata` volume for this project.
  - Start stack again.

---

## 5) Next steps (optional, recommended)

- Move secrets to **GitHub Actions Environments** or a secrets manager.
- Switch React to a production build + Nginx static hosting.
- TLS for Nginx (Let’s Encrypt / certbot).
- Add a read-only DB user for the API.
