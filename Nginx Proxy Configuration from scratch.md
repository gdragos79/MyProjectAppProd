Here’s a **copy-paste ready** markdown you can add to your repo as `docs/PROXY_SETUP_BLUE_GREEN.md` (or any name you prefer). It walks through setting up the Nginx proxy for **Blue/Green** from scratch, with safe commands and sanity checks.

````markdown
# Blue/Green Proxy Setup (Nginx) — From Scratch

This guide configures a single **proxy VM** running Nginx to front your **Blue/Green** application VMs.  
It uses a simple symlink (`active.conf`) to switch between **blue** and **green** upstreams, and is compatible with our GitHub Actions production workflow.

---

## TL;DR (what you’ll get)

- Directory layout:
  - Real upstream files: `/etc/nginx/upstreams-available/{upstream-blue.conf, upstream-green.conf}`
  - Active symlink: `/etc/nginx/upstreams/active.conf → ...upstream-blue.conf|...upstream-green.conf`
  - Site config (default vhost): `/etc/nginx/sites-available/default` including `active.conf`
- Backend health endpoint expected at: **`/api/health`**
- Frontend served via the proxy at `/`
- Safe reloads: `nginx -t && systemctl reload nginx`
- (Optional) passwordless sudo for the runner user to flip/reload

> **Assumptions**
> - **Blue VM (Prod)** backend+frontend on: `192.168.238.141` (backend on port **3000**, frontend on **80**)
> - **Green VM (Prod)** IP: **REPLACE_ME** (backend on **3000**, frontend on **80**)
> - Proxy VM uses Ubuntu/Debian Nginx layout.

---

## 0) Prerequisites (one time)

```bash
# On the PROXY VM
sudo apt-get update -y
sudo apt-get install -y nginx curl

# (Optional) open HTTP port if UFW is enabled
sudo ufw allow 'Nginx Full' || true
````

---

## 1) Create the directory layout

Real upstreams live in `upstreams-available/`. The proxy includes ONLY the `active.conf` symlink from `upstreams/`.

```bash
sudo mkdir -p /etc/nginx/upstreams-available
sudo mkdir -p /etc/nginx/upstreams
```

---

## 2) Create upstream files (Blue & Green)

> Replace `<GREEN_VM_IP>` below with your Green VM IP.

```bash
# Blue
sudo tee /etc/nginx/upstreams-available/upstream-blue.conf >/dev/null <<'NGINX'
# Blue color upstreams
upstream app_frontend {
  server 192.168.238.141:80 fail_timeout=5s;
}
upstream app_backend {
  server 192.168.238.141:3000 fail_timeout=5s;
}
NGINX

# Green
sudo tee /etc/nginx/upstreams-available/upstream-green.conf >/dev/null <<'NGINX'
# Green color upstreams
upstream app_frontend {
  server <GREEN_VM_IP>:80 fail_timeout=5s;
}
upstream app_backend {
  server <GREEN_VM_IP>:3000 fail_timeout=5s;
}
NGINX
```

---

## 3) Point `active.conf` to Blue (initially)

```bash
sudo ln -sfn /etc/nginx/upstreams-available/upstream-blue.conf /etc/nginx/upstreams/active.conf
ls -l /etc/nginx/upstreams
```

You should see:
`active.conf -> /etc/nginx/upstreams-available/upstream-blue.conf`

---

## 4) Write the site config to include the active upstream

This replaces `/etc/nginx/sites-available/default` so that **all** traffic is proxied to the **active** color.

```bash
sudo tee /etc/nginx/sites-available/default >/dev/null <<'NGINX'
# Include the active color's upstreams (symlink → upstream-blue.conf or upstream-green.conf)
include /etc/nginx/upstreams/active.conf;

server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;

  client_max_body_size 10m;
  proxy_read_timeout 60s;

  # API → backend on active color
  # NOTE: no trailing slash, so /api/* is preserved as /api/* on the backend.
  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://app_backend;
  }

  # Frontend → frontend on active color
  location / {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://app_frontend;
  }
}
NGINX

# Ensure enabled symlink exists
sudo ln -sfn /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
```

> **Important:** Do not include other upstream files anywhere else (e.g., avoid `include /etc/nginx/upstreams/*.conf;`).
> Only `include /etc/nginx/upstreams/active.conf;` should be present.

If you previously had duplicate includes, park them:

```bash
sudo mkdir -p /etc/nginx/conf.d.disabled
[ -f /etc/nginx/conf.d/site.conf ] && sudo mv /etc/nginx/conf.d/site.conf /etc/nginx/conf.d.disabled/
[ -f /etc/nginx/conf.d/staging.conf ] && sudo mv /etc/nginx/conf.d/staging.conf /etc/nginx/conf.d.disabled/
```

---

## 5) Test & reload Nginx

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 6) Sanity checks

```bash
# Which color is active?
readlink -f /etc/nginx/upstreams/active.conf

# Health via proxy (goes to the active color backend)
curl -i http://127.0.0.1/api/health
```

If your backend is up on the active color, this should return `200 OK` and your JSON payload.

---

## 7) Manual Blue ↔ Green flips (for testing)

```bash
# Flip to GREEN
sudo ln -sfn /etc/nginx/upstreams-available/upstream-green.conf /etc/nginx/upstreams/active.conf
sudo nginx -t && sudo systemctl reload nginx

# Flip back to BLUE
sudo ln -sfn /etc/nginx/upstreams-available/upstream-blue.conf /etc/nginx/upstreams/active.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## 8) Secure non-interactive reload for GitHub runner (optional but recommended)

If your **proxy VM** has a self-hosted runner (label `proxy`) and your Production workflow needs to reload Nginx, allow passwordless reload for your runner user (e.g., `gdragos`):

```bash
# On the PROXY VM
echo 'gdragos ALL=(root) NOPASSWD: /usr/sbin/nginx, /usr/sbin/nginx -t, /bin/systemctl reload nginx, /usr/bin/systemctl reload nginx' \
| sudo tee /etc/sudoers.d/gh-runner-nginx

sudo visudo -cf /etc/sudoers.d/gh-runner-nginx  # validate
```

Your workflow steps can then run:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

without prompting for a password.

---

## 9) Trailing slash gotcha (important)

* **Keep**: `proxy_pass http://app_backend;` (no trailing slash) in `location /api/`.

  * This preserves `/api/*` on the upstream.
* If you switch to `proxy_pass http://app_backend/;`, Nginx will **strip `/api`** and call the upstream at `/…` directly. That only works if your backend also handles `/health` without the `/api` prefix.

> Robust backend tip (optional): expose both
>
> ```js
> app.get(['/api/health', '/health'], (req, res) => res.json({ok:true}));
> ```

---

## 10) Integrate with the Production workflow

In `.github/workflows/production-sbx.yml`, ensure these paths match this guide:

```yaml
env:
  ACTIVE_LINK: /etc/nginx/upstreams/active.conf
  BLUE_CONF:  /etc/nginx/upstreams-available/upstream-blue.conf
  GREEN_CONF: /etc/nginx/upstreams-available/upstream-green.conf
```

The workflow will:

1. Deploy to the **inactive** color VM runner (`blue` or `green`).
2. Health-check locally (`http://127.0.0.1:3000/api/health`) pre-flip.
3. Flip `active.conf` to the new color on the proxy runner and reload Nginx.
4. Health-check via proxy (`http://127.0.0.1/api/health`) and **soak** (default 10 min).
5. **Auto-rollback** the symlink on failure.

---

## 11) Troubleshooting

* **Duplicate upstream “app_frontend/app_backend”**

  * You’re including the same upstreams multiple times. Ensure **only** `include /etc/nginx/upstreams/active.conf;` is present.
  * Move real files to `upstreams-available/`, and keep only the **symlink** in `upstreams/`.

* **502 Bad Gateway**

  * Check backend container is listening on **3000** on the active color VM:

    ```bash
    curl -i http://<ACTIVE_VM_IP>:3000/api/health
    ```
  * Confirm `upstream-*.conf` points to the right IPs and ports.

* **Reload asks for password in Actions**

  * Add the sudoers rule in §8 for your runner user.

* **Health fails only via proxy**

  * Verify trailing slash rules in §9.
  * Confirm the proxy and backend agree on `/api/health`.

---

## 12) Quick reference (commands)

```bash
# Test + reload
sudo nginx -t && sudo systemctl reload nginx

# Show current upstream target
readlink -f /etc/nginx/upstreams/active.conf

# Flip to green
sudo ln -sfn /etc/nginx/upstreams-available/upstream-green.conf /etc/nginx/upstreams/active.conf
sudo nginx -t && sudo systemctl reload nginx

# Flip to blue
sudo ln -sfn /etc/nginx/upstreams-available/upstream-blue.conf /etc/nginx/upstreams/active.conf
sudo nginx -t && sudo systemctl reload nginx

# Proxy health (hits active color)
curl -i http://127.0.0.1/api/health
```

---

**Done.** Your proxy now supports reliable Blue/Green flips with simple symlink changes and safe reloads, ready for CI/CD automation.

```
```
