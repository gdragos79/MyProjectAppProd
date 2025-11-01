Yep—that pending job means there’s **no self-hosted runner online** with the label `staging`. Here’s a **copy-paste, start-to-finish** guide to install one on your Staging VM and get the workflow moving.

---

# 0) What you need

* Staging VM SSH access (you said: `192.168.238.141`, user `gdragos`)
* Repo: `gdragos79/MyProjectAppProd`
* Your workflow already expects: `runs-on: [self-hosted, staging]`

> The runner makes an **outbound** connection to GitHub. You don’t need to open inbound ports.

---

# 1) SSH into the Staging VM

```bash
ssh gdragos@192.168.238.141
```

---

# 2) (One-time) Prepare Docker + basic tools

If Docker is already installed and working on that VM, you can skip the install lines. It’s safe to re-run.

```bash
# become root for a moment
sudo su - <<'ROOT'
set -e

# packages we need
apt-get update -y
apt-get install -y curl tar ca-certificates

# install Docker if missing
if ! command -v docker >/dev/null 2>&1; then
  apt-get install -y docker.io
  systemctl enable --now docker
fi

# make sure your user can use docker without sudo
usermod -aG docker gdragos

ROOT

# IMPORTANT: refresh your shell groups so 'docker' works without sudo
newgrp docker <<'EOF'
docker ps >/dev/null 2>&1 || true
EOF
```

---

# 3) Create the GitHub Actions runner

> You’ll need a **registration token** from GitHub UI:
>
> * Repo → **Settings** → **Actions** → **Runners** → **New self-hosted runner** → choose **Linux x64**
> * Copy the **Registration token** (valid ~1 hour)

Now run these **exact** commands on the VM (paste all of it):

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner

# Pick a runner version (2.329.0 is current as seen in your logs)
RUNNER_VER=2.329.0
curl -L -o actions-runner-linux-x64-${RUNNER_VER}.tar.gz \
  https://github.com/actions/runner/releases/download/v${RUNNER_VER}/actions-runner-linux-x64-${RUNNER_VER}.tar.gz

tar xzf actions-runner-linux-x64-${RUNNER_VER}.tar.gz

# Replace TOKEN_HERE with the token you copied from the UI
./config.sh \
  --url https://github.com/gdragos79/MyProjectAppProd \
  --token TOKEN_HERE \
  --name staging-vm-01 \
  --labels staging \
  --unattended
```

If you see a prompt about “enter work folder”, just accept the default.

---

# 4) Install the runner as a service & start it

```bash
sudo ./svc.sh install
sudo ./svc.sh start
```

Verify it’s running:

```bash
sudo ./svc.sh status
# or
sudo journalctl -u actions.runner.* -n 100 --no-pager
```

You should also see it **Online** in:
**Repo → Settings → Actions → Runners** (label: `staging`).

---

# 5) Re-run your workflow

Back in GitHub → **Actions → STG SBX (build → push → deploy on self-hosted → …)**

* Click **Run workflow**
* **Use workflow from**: `restructure/monorepo`

It will now pick up the **self-hosted** runner and proceed with:

* `docker login` (using `GITHUB_TOKEN`)
* `docker pull` your image from GHCR
* run the container on **port 3001 → 3000**
* `/api/health` probe

---

## Troubleshooting (copy-paste fixes)

**A) Runner stuck on “Waiting for a runner to pick up this job…”**

* Check that the runner shows **Online** in Settings → Actions → Runners.
* Ensure the label matches exactly: `staging`
* Make sure the job line is exactly:

  ```yaml
  runs-on: [self-hosted, staging]
  ```

**B) “docker: permission denied” on the runner**

```bash
# on the VM
sudo usermod -aG docker gdragos
sudo systemctl restart docker
sudo systemctl restart "$(systemctl list-units --type=service | awk '/actions\.runner/ {print $1; exit}')"
# or simply:
cd ~/actions-runner
sudo ./svc.sh restart
```

**C) Want to update the runner later**

```bash
cd ~/actions-runner
sudo ./svc.sh stop
./bin/installdependencies.sh || true
./config.sh remove --unattended
# then repeat Step 3 with a newer RUNNER_VER and re-register
```

**D) Need to see live logs while a job runs**

```bash
sudo journalctl -u actions.runner.* -f
```

---

## Why we switched to self-hosted here

Your Staging VM is on a **private LAN IP (192.168.x.x)**. GitHub-hosted runners on the public internet **cannot SSH to it**, which broke the previous SSH approach. A self-hosted runner runs **on** the VM, eliminating all network/known_hosts issues for deploy.

---

When the runner shows **Online**, re-run the staging workflow. If anything fails after this (e.g., image pull, container start, health check), paste the failing step + a few log lines and I’ll fix it immediately.
