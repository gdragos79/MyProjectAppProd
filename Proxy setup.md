
### Option A (recommended): Local hostnames on the Proxy VM (`/etc/hosts`)

* Only the Proxy VM needs to resolve these names.
* Upstream files refer to **hostnames**, not IPs.
* If an IP changes, you update **/etc/hosts** (one place), not Nginx files.

**1) On the Proxy VM, map names to your App VMs (private LAN IPs):**

```bash
# >>> EDIT THESE IPs to your actual LAN addresses (never commit these) <<<
BLUE_IP="192.168.XX.BLUE"
GREEN_IP="192.168.XX.GREEN"

# Add or update the hostnames in /etc/hosts on the Proxy VM only
sudo sed -i '/\bblue-app\.lan\b/d;/\bgreen-app\.lan\b/d' /etc/hosts
echo "$BLUE_IP  blue-app.lan"  | sudo tee -a /etc/hosts
echo "$GREEN_IP green-app.lan" | sudo tee -a /etc/hosts

# Sanity check resolution
getent hosts blue-app.lan
getent hosts green-app.lan
```

**2) Create the upstream include files (no IPs, only hostnames):**

```bash
sudo mkdir -p /home/gdragos/proxy/nginx/upstreams

# Backend upstreams (port 3000)
sudo tee /home/gdragos/proxy/nginx/upstreams/backend-blue.conf  >/dev/null <<'EOF'
server blue-app.lan:3000 max_fails=3 fail_timeout=5s;
EOF
sudo tee /home/gdragos/proxy/nginx/upstreams/backend-green.conf >/dev/null <<'EOF'
server green-app.lan:3000 max_fails=3 fail_timeout=5s;
EOF

# Frontend upstreams (port 80)
sudo tee /home/gdragos/proxy/nginx/upstreams/frontend-blue.conf  >/dev/null <<'EOF'
server blue-app.lan:80 max_fails=3 fail_timeout=5s;
EOF
sudo tee /home/gdragos/proxy/nginx/upstreams/frontend-green.conf >/dev/null <<'EOF'
server green-app.lan:80 max_fails=3 fail_timeout=5s;
EOF

# Set initial actives (choose blue or green)
cd /home/gdragos/proxy/nginx/upstreams
sudo ln -sf backend-blue.conf  active_backend.conf
sudo ln -sf frontend-blue.conf active_frontend.conf
```

**3) Confirm your site config uses the includes (already aligned with your setup):**

```nginx
upstream app_frontend {
  include /home/gdragos/proxy/nginx/upstreams/active_frontend.conf;
  keepalive 32;
}
upstream app_backend {
  include /home/gdragos/proxy/nginx/upstreams/active_backend.conf;
  keepalive 32;
}
```

**4) Validate & reload Nginx (won’t reload on error):**

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**5) Quick health probes (through the Proxy VM):**

```bash
curl -I  http://127.0.0.1/
curl -is http://127.0.0.1/api/healthz | head -1   # if your site.conf routes /api to backend
```

> Permissions tip: tighten access
>
> ```bash
> sudo chown -R root:root /home/gdragos/proxy/nginx
> sudo chmod -R 750 /home/gdragos/proxy/nginx
> ```
>
> These files aren’t secrets, but reducing exposure is good hygiene.

---

### Option B (also fine): Private DNS / MagicDNS

* If you have an internal DNS zone (e.g., `blue-app.internal`, `green-app.internal`) or Tailscale MagicDNS names, put those **hostnames** in the upstream files. No changes to Nginx beyond the hostnames.
* Ensure the Proxy VM can resolve those names (no `/etc/hosts` needed).

---

## Auto-generated?

**No.** Nginx won’t generate these files for you. The snippets above are meant to be **copy-pasted** once; after that, your workflow flips only the **symlinks**:

```bash
# Flip to green
cd /home/gdragos/proxy/nginx/upstreams
sudo ln -sf backend-green.conf  active_backend.conf
sudo ln -sf frontend-green.conf active_frontend.conf
sudo nginx -t && sudo systemctl reload nginx

```##########################################################
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
