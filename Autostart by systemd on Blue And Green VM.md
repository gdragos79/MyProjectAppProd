Awesome—here’s a **clean, end-to-end, copy-pasteable guide** to secure your Docker Compose environment variables using **systemd-encrypted credentials**. It’s written to work on **any app machine** (Blue or Green). I’ll also show safe fallbacks if your OS doesn’t have `systemd-creds`.

---

# Goal (what you get)

* ✅ Secrets **encrypted at rest** (bound to that machine’s key).
* ✅ Secrets **decrypted in RAM only** at service start (`/run/credentials/...`).
* ✅ Docker Compose receives env values via `--env-file`, not plain files on disk.
* ✅ Autostart on reboot via systemd.
* ✅ Clear troubleshooting for common mistakes.

> Use this on **App VMs** (Blue/Green). You typically **don’t** need it on the Proxy VM or DB VM.

---

# Prerequisites (one time per machine)

### 0) Check systemd + docker compose

```bash
systemd --version     # systemd ≥ 249 is ideal (Ubuntu 22.04/24.04 OK)
docker compose version
```

### 1) Make sure you have a Compose project directory

We’ll assume:

* Compose file at: `/home/gdragos/app/docker-compose.yml`
* Systemd unit name: `myproject-app.service`

Create the directory if it doesn’t exist:

```bash
sudo mkdir -p /home/gdragos/app
```

If you don’t have a compose yet, here’s a minimal template (edit images as needed):

```bash
sudo tee /home/gdragos/app/docker-compose.yml >/dev/null <<'YAML'
name: myprojectappprod
services:
  frontend:
    image: ghcr.io/OWNER/REPO-frontend:${TAG:-latest}
    restart: unless-stopped
    ports: ["80:80"]
    depends_on: [backend]

  backend:
    image: ghcr.io/OWNER/REPO-backend:${TAG:-latest}
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      PORT: 3000
      DB_HOST: ${DB_HOST?DB_HOST not set}
      DB_PORT: ${DB_PORT?DB_PORT not set}
      DB_USER: ${DB_USER?DB_USER not set}
      DB_PASSWORD: ${DB_PASSWORD?DB_PASSWORD not set}
      DB_NAME: ${DB_NAME?DB_NAME not set}
YAML
```

---

# Part A — Create the encrypted credential (per machine)

> Run all commands **on the App VM** (Blue or Green). Repeat on the other App VM.

### 1) Create the encrypted-credential store and host key

```bash
# secure store for ciphertext
sudo install -d -m 700 /etc/credstore.encrypted

# create host key (used to encrypt/decrypt credentials)
sudo systemd-creds setup
```

> You may see: “credential.secret is not on encrypted media” — that’s a **warning** only. You can harden later (tips at the end).

### 2) Write a **temporary** plaintext env (edit values!)

```bash
cat > /tmp/app.env <<'ENV'
DB_HOST=192.168.xxx.xxx
DB_PORT=5432
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_db_name
PORT=3000
NODE_ENV=production
# Optional: pin an image tag; otherwise compose uses :latest
# TAG=latest
ENV
```

### 3) Encrypt it (host-bound + name metadata)

```bash
# --with-key=host binds decryption to this machine
# --name=app.env embeds a name; we'll reference it in the unit
sudo systemd-creds encrypt --with-key=host --name=app.env \
  /tmp/app.env /etc/credstore.encrypted/app.env

# Erase plaintext
shred -u /tmp/app.env
# On the Staging VM:
sudo install -d -m 700 /etc/credstore.encrypted
tmpfile=$(mktemp /tmp/app_staging.XXXXXX.env)
umask 077

cat > "$tmpfile" <<'ENV'
TAG=latest
DB_HOST_STAGING=192.168.XXX.XXX
DB_PORT_STAGING=5432
DB_USER_STAGING=deploy
DB_PASSWORD_STAGING=your password
DB_NAME_STAGING=your db name
VITE_API_BASE_URL=/api
ENV

# For your systemd-creds version: encrypt <OUTPUT> <INPUT>
sudo systemd-creds encrypt /etc/credstore.encrypted/app-staging.env "$tmpfile"

# Securely wipe the temporary plaintext (on prod and staging machines)
shred -u "$tmpfile"
```

### 4) Verify you can decrypt it locally

```bash
sudo systemd-creds decrypt /etc/credstore.encrypted/app.env - | head
```

You should see your key=value lines.

---

# Part B — Systemd unit that decrypts to RAM and starts Compose

> We hardcode the RAM path to avoid path typos. If you rename the unit, update the path accordingly.

```bash
sudo tee /etc/systemd/system/myproject-app.service >/dev/null <<'UNIT'
[Unit]
Description=MyProject App Stack (Blue/Green)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/home/gdragos/app
# Decrypts the encrypted cred into RAM at:
#   /run/credentials/myproject-app.service/app.env
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

sudo systemctl daemon-reload
```

### (If using private GHCR images) Log in once **as root**

```bash
sudo -i
echo '<GHCR_PAT_with_read:packages>' | docker login ghcr.io -u '<github_username>' --password-stdin
exit
```

### Start + enable

```bash
sudo systemctl enable --now myproject-app
systemctl status myproject-app --no-pager
```

---

# Part C — Operating and verifying

### 1) Health checks

```bash
docker compose -f /home/gdragos/app/docker-compose.yml ps        # requires env to parse (see wrapper below)
curl -I http://localhost/                                        # frontend should 200
curl -is http://localhost:3000/healthz | head -1                 # 200 if implemented; 404 if not yet
```

> If you get “required variable DB_* is missing” when running any `docker compose` command, that’s because Compose re-parses your file and needs the env. Use the wrapper below.

### 2) Handy wrapper for manual Compose commands (always decrypts to a temp file)

```bash
sudo tee /usr/local/bin/myapp-compose >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail
tmp="$(mktemp)"
trap 'shred -u "$tmp"' EXIT
sudo systemd-creds decrypt /etc/credstore.encrypted/app.env - > "$tmp"
exec docker compose --env-file "$tmp" -f /home/gdragos/app/docker-compose.yml "$@"
SH
sudo chmod +x /usr/local/bin/myapp-compose
```

Now run:

```bash
myapp-compose ps
myapp-compose logs -f backend
myapp-compose pull
myapp-compose up -d
```

### 3) Rotating secrets (safely)

When you need to change DB password or host:

```bash
# Decrypt -> edit -> re-encrypt in place
sudo systemd-creds decrypt /etc/credstore.encrypted/app.env - > /tmp/app.env
nano /tmp/app.env   # edit values
sudo systemd-creds encrypt --with-key=host --name=app.env \
  /tmp/app.env /etc/credstore.encrypted/app.env.new
sudo mv /etc/credstore.encrypted/app.env.new /etc/credstore.encrypted/app.env
shred -u /tmp/app.env

# Restart app so new values apply
sudo systemctl restart myproject-app
```

---

# Part D — Troubleshooting (fast map)

| Symptom / log                                                                  | Likely cause                                                                            | Fix                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `status=200/CHDIR` / “Changing to working directory failed”                    | Missing folder in `WorkingDirectory`                                                    | `sudo mkdir -p /home/gdragos/app`                                                                    |
| `couldn't find env file: /run/credentials/.../app.env`                         | Wrong RAM path (missing `.service`) or unit typo                                        | Use **exact path** `/run/credentials/myproject-app.service/app.env` in both `ExecStart` & `ExecStop` |
| `Embedded credential name 'X' does not match filename 'Y'`                     | You encrypted with `--name=X` but saved as `Y`                                          | Either rename file to `X` or re-encrypt with `--name=Y`                                              |
| `Credential 'myproject-app.service' not set.` (with `systemd-creds cat`)       | For `Type=oneshot`, credentials exist only during `ExecStart`, or the unit failed early | Check journal; test manual compose with a temp-decrypted env; ensure unit starts                     |
| `manifest unknown` when pulling                                                | Tag doesn’t exist in registry                                                           | Set/remove `TAG` in the encrypted env (e.g., `TAG=latest`) and restart                               |
| `required variable DB_* is missing` when running `docker compose ...` manually | You didn’t pass an env file                                                             | Use the wrapper or `--env-file` with a temp-decrypted file                                           |
| Ports 80/3000 already in use                                                   | Old containers still running or native nginx                                            | `docker ps`; `docker rm -f ...`; disable native nginx if using containerized frontend                |

View logs:

```bash
journalctl -xeu myproject-app -n 100 --no-pager
```

---

# Security hardening (nice-to-have)

* **Lock down host key file** (used for encryption/decryption):

  ```bash
  sudo chown root:root /var/lib/systemd/credential.secret
  sudo chmod 600 /var/lib/systemd/credential.secret
  ```
* **TPM2 sealing** (if available) — stronger at-rest protection:

  ```bash
  systemd-creds has-tpm2 || echo "No TPM2 available"
  # If available, re-encrypt using both host+TPM2:
  sudo systemd-creds encrypt --with-key=host+tpm2 --name=app.env \
    /etc/credstore.encrypted/app.env \
    /etc/credstore.encrypted/app.env.new
  sudo mv /etc/credstore.encrypted/app.env.new /etc/credstore.encrypted/app.env
  ```
* **Full-disk encryption (LUKS)** for the VM’s root disk (makes the “not on encrypted media” warning a non-issue).
* **Cloned VMs:** ensure each has a unique machine-id:

  ```bash
  sudo rm -f /etc/machine-id
  sudo systemd-machine-id-setup
  cat /etc/machine-id
  ```

  Then **re-encrypt** the credential on the new machine (host-bound blobs won’t decrypt elsewhere).
* **Firewall**: limit DB port to Blue/Green IPs only, and restrict SSH exposure.

---

# Fallbacks if `systemd-creds` isn’t available

* **Ephemeral /run env (no secrets on disk, no autostart):**
  In your CI deploy step (or manual SSH), write the env to `/run/myproject/app.env` (tmpfs) and start Compose with `--env-file /run/myproject/app.env`. After reboot, redeploy.

* **Docker “secrets” + wrapper:**
  Mount secret files into the container at `/run/secrets/*` and set envs from them in the container entrypoint. (Slightly more Compose wiring; good when you never want envs visible in `docker inspect`.)

---

## Final sanity checklist (per App VM)

* [ ] `/home/gdragos/app/docker-compose.yml` exists.
* [ ] `/etc/credstore.encrypted/app.env` decrypts locally.
* [ ] Unit uses `LoadCredentialEncrypted=app.env:/etc/credstore.encrypted/app.env`.
* [ ] Unit `ExecStart`/`ExecStop` use `/run/credentials/myproject-app.service/app.env`.
* [ ] `sudo systemctl enable --now myproject-app` shows **active**.
* [ ] `curl -I http://localhost/` returns 200 (frontend), `/healthz` optional.

If anything misbehaves, paste the **last 50 lines** of:

```
journalctl -xeu myproject-app -n 50 --no-pager
```

and I’ll pinpoint the exact tweak.


