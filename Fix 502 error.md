Got it — your backend is failing DB auth:

```
password authentication failed for user "postgres"
Client has already been connected. You cannot reuse a client.
```

That 502 from the proxy is just a symptom. Let’s fix DB auth first (fastest path), then confirm the app.

---

## Step 1 — Confirm what the backend is trying to use (on the App VM)

```bash
# If you have the helper:
myapp-compose run --rm backend sh -lc 'printf "%s\n" "$DB_HOST" "$DB_PORT" "$DB_USER" "$DB_NAME"'
# Or decrypt your env file and look:
sudo systemd-creds decrypt /etc/credstore.encrypted/app.env - | sed 's/^\(DB_PASSWORD=\).*/\1********/g'
```

Make sure it’s the **DB you intend** (IP/port), user, db name, and the expected password.

---

## Step 2 — Test those exact creds from the App VM

```bash
# Export from the decrypted env (edit path if needed)
tmp=/tmp/app.env; sudo systemd-creds decrypt /etc/credstore.encrypted/app.env - > "$tmp"
set -a; . "$tmp"; set +a

# Try a simple query with the same host/port/user/db
PGPASSWORD="$DB_PASSWORD" psql "postgresql://$DB_USER@$DB_HOST:$DB_PORT/$DB_NAME?connect_timeout=5" -c "SELECT 1;"
```

* If this **fails with “password authentication failed”**, your app password does **not** match the DB’s password for that user.
* If it **succeeds**, the issue is inside the container’s env (not what systemd decrypts) — see **Step 4**.

When done:

```bash
shred -u "$tmp"
```

---

## Step 3 — Fix the mismatch (pick ONE)

### Option A — Change the DB to the password your app already uses (quickest)

On the **DB VM**:

```bash
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'password1234';"
# reload config (safe):
sudo -u postgres psql -c "SELECT pg_reload_conf();"
```

> Replace `password1234` with the value in your encrypted env if it’s different.

Make sure `pg_hba.conf` allows your App VM IP(s):

```
# Example – adapt your LAN/CIDR
host    all     all     192.168.238.0/24      md5
```

Then reload:

```bash
sudo -u postgres psql -c "SELECT pg_reload_conf();"
```

### Option B — Use a dedicated app user (more secure)

On the **DB VM**:

```sql
-- as postgres superuser:
CREATE ROLE myapp LOGIN PASSWORD 'CHANGEME';
GRANT ALL PRIVILEGES ON DATABASE myappdb TO myapp;
ALTER DATABASE myappdb OWNER TO myapp;
ALTER SCHEMA public OWNER TO myapp;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO myapp;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO myapp;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO myapp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO myapp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO myapp;
```

Then **update your encrypted env** to:

```
DB_USER=myapp
DB_PASSWORD=CHANGEME
```

(How to update — see Step 4)

### Option C — Change the app’s secret to the DB’s current password

On the **App VM**:

```bash
# Decrypt -> edit -> re-encrypt
sudo systemd-creds decrypt /etc/credstore.encrypted/app.env - > /tmp/app.env
nano /tmp/app.env   # set DB_USER/DB_PASSWORD to what the DB expects
sudo systemd-creds encrypt --with-key=host --name=app.env \
  /tmp/app.env /etc/credstore.encrypted/app.env.new
sudo mv /etc/credstore.encrypted/app.env.new /etc/credstore.encrypted/app.env
shred -u /tmp/app.env
```

---

## Step 4 — Restart app and re-check

```bash
sudo systemctl restart myproject-app
journalctl -xeu myproject-app -n 50 --no-pager
```

Sanity from the App VM:

```bash
# If you have the helper
myapp-compose logs -f backend
# Or directly:
docker logs --since=5m $(docker ps --filter name=backend --format '{{.ID}}')
```

You should **no longer** see “password authentication failed”.

---

## Step 5 — (If needed) run Prisma migrations

If the backend still restarts/crashes on first queries, you may need migrations:

```bash
# From the backend container, using its env:
BACK=$(docker ps --filter name=backend --format '{{.Names}}' | head -1)
docker exec -it "$BACK" sh -lc '
  command -v npx >/dev/null 2>&1 || { echo "npx not found"; exit 1; }
  npx prisma migrate deploy
  npx prisma migrate status || true
'
```

---

## Step 6 — Confirm proxy and app paths

* From **App VM**:

  ```bash
  curl -is http://127.0.0.1:3000/healthz | head -1
  curl -is http://127.0.0.1:3000/users | head -1
  ```
* From **Proxy VM**, target the active color’s IP:

  ```bash
  curl -is http://<ACTIVE_APP_VM_IP>:3000/healthz | head -1
  ```

If direct to backend is **200**, but the browser still sees **502**, the proxy is pointing wrong — check the upstream files and reload nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## Why you saw “Client has already been connected…”

That’s a side-effect of your app retrying after a failed auth using the **same** PG client instance. Once credentials are correct, that symptom should disappear. Long-term, use a connection **pool** and ensure your retry logic creates a fresh client (or reuses pool) after failures.

---

### If it still fails

Paste the **exact outputs** of:

* `PGPASSWORD=... psql "postgresql://..." -c "SELECT 1;"` (from the App VM using the app’s env)
* `docker logs --since=5m $(docker ps --filter name=backend --format '{{.ID}}')`
* `sudo tail -n 50 /var/log/nginx/error.log` (Proxy VM)

…and I’ll give you the next (very specific) fix.
