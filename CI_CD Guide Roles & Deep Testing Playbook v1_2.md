# CI/CD Guide: Roles & Deep Testing Playbook (v1.2)

## 0) Glossary & Topology (anchor this in your head)

* **Blue App VM** — current live production app VM.
* **Green App VM** — staging app VM (the “next” candidate for production).
* **Proxy VM** — the nginx box that flips traffic between Blue and Green via `upstreams/active_{frontend,backend}.conf`.
* **DB VM** — PostgreSQL server. One DB instance shared by both app VMs.
* **GHCR** — GitHub Container Registry where images are pushed.
* **Systemd-encrypted env** — each App VM stores `/etc/credstore.encrypted/app.env`, decrypted into RAM at `/run/credentials/myproject-app.service/app.env` when the unit starts; Compose consumes it via `--env-file`.
* **Health endpoints** — backend exposes `GET /healthz`. Frontend root `GET /` should return `200`.

---

## 1) Pipeline ROLES (what each stage is responsible for)

### A) Development (CI) — “Prove it still builds and works”

**Goal:** Prove code changes compile, pass tests, and produce valid Docker images.
**What it does:**

* Runs backend tests + frontend build.
* On success, **pushes images to GHCR** with tags:

  * `ghcr.io/<owner>/myprojectappprod-backend:<sha>` and `:latest`
  * `ghcr.io/<owner>/myprojectappprod-frontend:<sha>` and `:latest`

**Why it matters:** Staging/Production can only **pull** if CI actually **pushed** valid images. No push → later deploys pull air.

---

### B) Staging (CD to Green) — “Rehearse production with real components”

**Goal:** Deploy the just-built images to **Green** as a dress rehearsal.
**What it does:**

* SSH into **Green App VM**.
* `docker compose pull` (downloads latest images from GHCR).
* Restart `myproject-app` systemd unit (uses **RAM-only env**).
* Run **Prisma migrations** (`npx prisma migrate deploy`) so schema matches the new code.
* Verify `/healthz` and basic app routes.
  **No end-users** see this environment yet.

**Why it matters:** It confirms images run with **your** DB, **your** VMs, and **your** config, before real traffic.

---

### C) Production (Proxy flip Blue↔Green) — “Go live safely, instantly reversible”

**Goal:** Shift live traffic from **Blue → Green** when Green is proven healthy.
**What it does:**

* On **Proxy VM**, update two symlinks:

  * `active_frontend.conf` → either `frontend-blue.conf` **or** `frontend-green.conf`
  * `active_backend.conf` → either `backend-blue.conf` **or** `backend-green.conf`
* `nginx -t && systemctl reload nginx`
  **Rollback:** flip the symlinks back and reload.

**Why it matters:** True **zero-downtime**, instant rollback, one DB, and a clean, auditable switch.

---

## 2) Pre-flight Checklist (do this once before testing pipelines)

* GitHub **secrets** set for SSH and registry (you already did):

  * `GREEN_SSH_HOST`, `GREEN_SSH_USER`, `GREEN_SSH_KEY`
  * `PROXY_SSH_HOST`, `PROXY_SSH_USER`, `PROXY_SSH_KEY`
* App VMs (Blue, Green):

  * `/home/gdragos/app/docker-compose.yml` present.
  * `/etc/credstore.encrypted/app.env` decrypts locally:

    ```bash
    sudo systemd-creds decrypt /etc/credstore.encrypted/app.env - | head
    ```
  * Systemd unit correct paths:

    * `LoadCredentialEncrypted=app.env:/etc/credstore.encrypted/app.env`
    * `--env-file /run/credentials/myproject-app.service/app.env`
* DB VM:

  * `listen_addresses='*'` (or LAN IP).
  * `pg_hba.conf` allows both App VM IPs (or your LAN CIDR) with `md5`.
* Proxy VM:

Make sure that you have followed the steps from ProxyVMSetup_NativeProxyMachine_Final and `sudo nginx -t` is clean.

---

## 3) TESTING the Development (CI) Pipeline

### 3.1 Positive “happy path” test

**Objective:** Confirm CI builds, tests, and pushes images.

1. **Create a small, safe change** on a new branch:

   ```bash
   git checkout -b feat/ci-smoke
   echo "// no-op comment" >> backend/src/ci_smoke.ts
   git add -A
   git commit -m "ci: smoke test commit"
   git push origin feat/ci-smoke
   ```

2. **Open a PR** to `development` (or push directly to `development` if that’s your flow).

3. **Watch the CI run** (GitHub Actions → the `ci` workflow):

   * Jobs you expect: `backend` (tests), `frontend` (build), `images` (build + push).
   * All three must be green.

4. **Verify images exist in GHCR:**

   * GitHub → Packages → confirm two images (frontend, backend) updated “a few minutes ago”.
   * OR pull locally:

     ```bash
     docker login ghcr.io
     docker pull ghcr.io/<owner>/myprojectappprod-backend:latest
     docker pull ghcr.io/<owner>/myprojectappprod-frontend:latest
     ```
   * **Expected:** both pull successfully, no `manifest unknown`.

**Pass criteria:** CI green; `latest` tags and `<sha>` tags present in GHCR; local `docker pull` succeeds.

---

### 3.2 Negative test: break the backend unit tests (VERY DETAILED, COPY/PASTE)

**Objective:** Ensure CI **blocks** image push when tests fail. We will deliberately create a failing test, run CI, observe failure, then fix and confirm success.

> **Assumptions:**
>
> * Backend uses Node.js with `npm test` wired (Jest/Mocha/Vitest etc.).
> * Repository root contains `backend/` folder.
>
> **If you have no tests configured yet**, use the “No test framework configured” path below.

#### A) Create a failing test (Jest/Mocha/Vitest already configured)

1. Create a branch and a failing test file:

   ```bash
   cd /path/to/your/checkout
   git checkout -b test/ci-negative-backend
   cd backend
   mkdir -p tests
   cat > tests/ci_negative.test.js <<'EOF'
   // Intentionally failing test for CI negative path
   describe('CI Negative Test', () => {
     it('should fail on purpose', () => {
       const twoPlusTwo = 2 + 2;
       expect(twoPlusTwo).toBe(5); // <-- will fail
     });
   });
   EOF
   git add tests/ci_negative.test.js
   git commit -m "test: add intentional failing test for CI validation"
   git push origin test/ci-negative-backend
   ```

2. Open a Pull Request (PR) into `development` using this branch.

3. Observe CI in GitHub → Actions → `ci` workflow for your PR:

   * `backend` job should **fail** (test failure should be visible in logs).
   * Because `images` job `needs: [backend, frontend]`, the `images` job should **not run**.

4. Verify **no new images** were pushed (optional):

   * GitHub Packages page for your repo shows **no** new `latest` timestamp.

5. **Fix** the test and re-run CI:

   ```bash
   # Fix the assertion to pass
   sed -i "s/toBe(5)/toBe(4)/" tests/ci_negative.test.js
   git add tests/ci_negative.test.js
   git commit -m "test: fix intentional failing test"
   git push
   ```

   * CI should re-run; `backend` now **passes**; `images` **runs and pushes**.

6. (Optional cleanup) Remove the test file:

   ```bash
   git rm tests/ci_negative.test.js
   git commit -m "chore: remove CI negative test"
   git push
   ```

   * Merge or close the PR when done.

#### B) No test framework configured yet (fallback path)

If `npm test` isn’t configured, create a minimal failing script and temporarily wire it:

1. Inspect current test script:

   ```bash
   cd backend
   cat package.json | sed -n '1,120p' | sed -n "s/.*\"test\".*/&/p"
   ```

2. Create a minimal test runner `tests/run.js` that exits non‑zero:

   ```bash
   mkdir -p tests
   cat > tests/run.js <<'EOF'
   // Minimal failing test runner (no framework required)
   console.log('Running minimal failing test...');
   const twoPlusTwo = 2 + 2;
   if (twoPlusTwo !== 5) {
     console.error('Expected 2+2 to equal 5 (intentional fail).');
     process.exit(1); // fail CI
   }
   EOF
   ```

3. Temporarily set `"test": "node tests/run.js"` in package.json:

   ```bash
   # If "test" exists, overwrite; if not, insert into scripts
   node -e '
   const fs=require("fs");
   const p=JSON.parse(fs.readFileSync("package.json","utf8"));
   p.scripts=p.scripts||{}; p.scripts.test="node tests/run.js";
   fs.writeFileSync("package.json", JSON.stringify(p,null,2));
   '
   git add package.json tests/run.js
   git commit -m "ci: wire minimal failing test"
   git push origin HEAD:test/ci-negative-backend
   ```

4. Open a PR to `development` and observe CI:

   * `backend` job should **fail** (exit code 1).
   * `images` job should **not** run.

5. **Fix** the runner to pass and re-run CI:

   ```bash
   sed -i "s/!== 5/=== 4/" tests/run.js
   git add tests/run.js
   git commit -m "ci: make minimal test pass"
   git push
   ```

   * CI should pass; `images` job should push to GHCR.

6. (Optional cleanup)

   ```bash
   # Revert the temporary test script change
   git checkout -- package.json
   git rm tests/run.js
   git commit -m "chore: cleanup minimal test runner"
   git push
   ```

**Pass criteria for 3.2:** When tests fail, `backend` job fails and **images are not pushed**. When tests pass, `backend` succeeds and **images are pushed to GHCR**.

---

## 4) TESTING the Staging (CD to Green) Pipeline

> We assume you have a `deploy-staging.yml` that does:
>
> * SSH to **Green**
> * `docker compose pull`
> * restart `myproject-app`
> * (optional) run Prisma migrations
> * quick health checks

### 4.1 Positive test: deploy latest images to Green

1. Make a benign change (or reuse your CI smoke commit) and **merge to `staging`**.
2. Confirm the **deploy-staging** workflow triggers on that push (or trigger manually with “Run workflow”).
3. Open the workflow logs; look for:

   * SSH connect success.
   * `docker compose -f /home/gdragos/app/docker-compose.yml pull` logs showing **new layers** or “Image is up to date”.
   * `systemctl start myproject-app` (or restart) succeeded.
   * Optional migrations step: `npx prisma migrate deploy` ran without error.
4. SSH into **Green App VM** and verify:

   ```bash
   systemctl status myproject-app --no-pager
   docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'

   # Backend locally:
   curl -is http://127.0.0.1:3000/healthz | head -1
   # Frontend locally:
   curl -I  http://127.0.0.1/
   ```

   * **Expected:** `HTTP/1.1 200 OK` from both endpoints.

**Pass criteria:** Images pulled; service started; `/healthz` 200; frontend `/` 200 on **Green VM**.

---

### 4.2 Negative test A: image tag doesn’t exist

**Objective:** Ensure the workflow fails clearly if it tries to pull a non-existent tag.

1. Temporarily set `TAG=sha-doesnotexist` in Green’s encrypted env:

   ```bash
   sudo systemd-creds decrypt /etc/credstore.encrypted/app.env - > /tmp/app.env
   sed -i 's/^TAG=.*/TAG=sha-doesnotexist/' /tmp/app.env
   sudo systemd-creds encrypt --with-key=host --name=app.env \
     /tmp/app.env /etc/credstore.encrypted/app.env.new
   sudo mv /etc/credstore.encrypted/app.env.new /etc/credstore.encrypted/app.env
   shred -u /tmp/app.env
   ```
2. Run `deploy-staging`.
3. **Expected:** `docker compose pull` errors with something like `manifest unknown`.
4. **Restore**: set `TAG=latest` (or remove the line), re-encrypt, restart unit. Re-run `deploy-staging`.

**Pass criteria:** Failure is explicit; restore succeeds.

---

### 4.3 Negative test B: DB auth mismatch

**Objective:** Confirm failures bubble up cleanly (so you see them before Production).

1. On DB VM, temporarily change the app user password to something wrong (or change Green’s env to a wrong password).
2. Deploy to Green.
3. Check backend logs:

   ```bash
   docker logs --since=10m $(docker ps --filter name=backend --format '{{.ID}}')
   ```

   **Expected:** messages like `password authentication failed for user ...`.
4. Restore password/secret; deploy again; confirm `/healthz` is 200.

**Pass criteria:** You can detect DB issues on staging and recover.

---

### 4.4 “End-to-end rehearsal” on Staging (optional but recommended)

* Run **Prisma migrations** in the deploy step every time; verify data shape is as expected.
* Hit **all critical API endpoints** (`/users`, POSTs, etc.) from the Green VM or a test client.
* Confirm frontend connects to backend (ideally via `/api/...` through proxy, but local checks are fine here).

### 4.5 Prisma migrations — very, very, very detailed instructions (copy/paste)

> **Purpose:** Ensure your database schema matches the code deployed to **Green**. In staging we use **`npx prisma migrate deploy`** because it is **idempotent** and applies only the **already-committed** migrations. We do **not** generate new migrations in staging/production.

#### 4.5.1 Concepts you must know (60‑second recap)

* **`migrate dev`** (local dev only): *creates* new migrations and applies them to a **development** DB. Do **not** run this in staging/prod.
* **`migrate deploy`** (staging/prod): *applies pending committed migrations* in a safe, idempotent manner. Run it **every deploy**.
* **`migrate status`**: shows if there are pending migrations or drift.
* **`db seed`**: optional data seeding if you have a seeding script configured.
* Migrations live under: `backend/prisma/migrations/` and are referenced by `backend/prisma/schema.prisma`.

#### 4.5.2 Preconditions (verify once per VM)

1. **DB access works from the backend container** (Green VM):

   ```bash
   BACK=$(docker ps --filter name=backend --format '{{.Names}}' | head -1)
   docker exec -it "$BACK" sh -lc '
     echo "Checking DB connectivity...";
     node -e "process.exit(!!(process.env.DB_HOST&&process.env.DB_USER&&process.env.DB_PASSWORD&&process.env.DB_NAME)?0:1)" && echo OK || { echo "Missing DB envs"; exit 1; }
     PGPASSWORD="$DB_PASSWORD" psql "postgresql://$DB_USER@$DB_HOST:$DB_PORT/$DB_NAME?connect_timeout=5" -c "SELECT 1;"
   '
   ```

   * **Expected:** `SELECT 1` returns 1 row; otherwise fix credentials/pg_hba.
2. **Prisma CLI available in image** (Green VM):

   ```bash
   docker exec -it "$BACK" sh -lc 'npx --yes prisma -v'
   ```

   * **Expected:** prints Prisma versions; if not, add prisma as devDependency or ship it in the image.

#### 4.5.3 Run migrations during staging deploy (two supported methods)

**Method A — via your GitHub Action (recommended):**
Add/keep this step after the service restart in `deploy-staging.yml`:

```yaml
- name: Run Prisma migrations
  uses: appleboy/ssh-action@v1.2.0
  with:
    host: ${{ env.HOST }}
    username: ${{ env.USER }}
    key: ${{ env.KEY }}
    script_stop: true
    script: |
      set -e
      BACK=$(docker ps --filter name=backend --format '{{{{.Names}}}}' | head -1)
      if [ -z "$BACK" ]; then echo "backend container not found"; exit 1; fi
      docker exec "$BACK" sh -lc '
        echo "==> prisma migrate deploy";
        npx prisma migrate deploy;
        echo "==> prisma migrate status";
        npx prisma migrate status || true;
        if npm pkg get scripts.seed | grep -qv null; then
          echo "==> prisma db seed (optional)";
          npx prisma db seed || true;
        fi
      '
```

**Method B — manual from SSH on Green VM:**

```bash
# 1) Identify backend container
BACK=$(docker ps --filter name=backend --format '{{.Names}}' | head -1)

# 2) Apply migrations (idempotent)
docker exec -it "$BACK" sh -lc 'npx prisma migrate deploy'

# 3) Show status (pending/applied/drift)
docker exec -it "$BACK" sh -lc 'npx prisma migrate status'

# 4) (Optional) Run seed if you have one
docker exec -it "$BACK" sh -lc 'npx prisma db seed || true'
```

#### 4.5.4 Creating migrations the **right** way (local dev only)

> Run this on your **local dev machine** against a **dev database**, never against staging/prod.

```bash
# On a feature branch, after editing backend/prisma/schema.prisma
cd backend
npm ci
# Creates a new named migration and updates your dev DB schema
npx prisma migrate dev --name add_users_table
# Generate Prisma client (if not auto-generated)
npx prisma generate
# Run unit/integration tests locally, then commit the new migration
git add prisma/migrations/* prisma/schema.prisma
git commit -m "chore(prisma): add_users_table migration"
# Push branch, let CI build & push images; the migration files are part of the repo.
```

#### 4.5.5 Expected outputs & how to interpret them

* **No pending migrations**:

  ```
  Prisma Migrate summary
  No pending migrations to apply.
  ```

  → OK. Schema is up to date.
* **Applied N migrations**:

  ```
  The following migration(s) have been applied:
  20251017_add_users_table
  20251017_add_index_email
  ```

  → OK. Verify app functionality immediately.
* **Drift detected / failure**:

  * Status shows drift or SQL errors (e.g., permission denied).
  * Actions:

    1. Verify DB user privileges (see grants below).
    2. Ensure the committed migration files **exist** in the image (they must be in the repo at build time).
    3. If manual changes were made directly to DB, align schema: create a corrective migration **in dev**, commit, redeploy.

#### 4.5.6 Common errors & fast fixes

* **`permission denied for table _prisma_migrations`** → DB user lacks privileges.

  ```sql
  -- On DB as superuser (postgres):
  GRANT ALL PRIVILEGES ON DATABASE myappdb            TO myapp;
  GRANT ALL PRIVILEGES ON SCHEMA public               TO myapp;
  GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO myapp;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO myapp;
  GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO myapp;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO myapp;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO myapp;
  ```
* **`P1001: Can’t reach database server`** → network/pg_hba/port wrong. Test with `psql` from the container.
* **`No such file or directory: prisma/migrations`** → migration files not in the image; ensure they’re committed and copied in Dockerfile.
* **`P3014 Drift detected`** → someone changed DB manually. Create a **new** migration in dev to bring code+DB back in sync, commit, redeploy.

#### 4.5.7 Safety rules (memorize)

* **Never** run `prisma migrate dev` in staging/prod.
* Always run **`prisma migrate deploy`** in staging before flipping prod.
* Keep migrations **small and frequent**; avoid big-bang schema changes.
* Prefer **transactional** migrations (PostgreSQL default) so failures auto‑rollback.
* After applying, **smoke-test** writes/reads that touch the changed tables.

#### 4.5.8 One‑liner you can paste in the staging workflow (idempotent)

```yaml
- name: Prisma deploy + status (idempotent)
  uses: appleboy/ssh-action@v1.2.0
  with:
    host: ${{ env.HOST }}
    username: ${{ env.USER }}
    key: ${{ env.KEY }}
    script: |
      set -e
      BACK=$(docker ps --filter name=backend --format '{{{{.Names}}}}' | head -1)
      docker exec "$BACK" sh -lc 'npx prisma migrate deploy && npx prisma migrate status || true'
```

---

## 5) TESTING the Production Flip (Proxy VM)

> Precondition: Both Blue and Green are up. Blue is live, Green is ready with newer images and returns 200 at `/healthz`.

### 5.1 Dry-run validation before flipping

**On Proxy VM:**

```bash
# What’s currently active?
readlink -f /home/gdragos/proxy/nginx/upstreams/active_frontend.conf
readlink -f /home/gdragos/proxy/nginx/upstreams/active_backend.conf

# Probe both targets directly (replace <BLUE_IP>, <GREEN_IP>)
curl -is http://<BLUE_IP>:3000/healthz | head -1
curl -is http://<GREEN_IP>:3000/healthz | head -1
```

* **Expected:** both return `HTTP/1.1 200 OK`.

### 5.2 Flip to Green

**In the `deploy-production.yml` (or manually via SSH):**

```bash
cd /home/gdragos/proxy/nginx/upstreams
ln -sf backend-green.conf  active_backend.conf
ln -sf frontend-green.conf active_frontend.conf
sudo nginx -t && sudo systemctl reload nginx
```

**Post-flip checks:**

* From your workstation/browser: open the site (through proxy) and test user flows.
* On Proxy VM:

  ```bash
  sudo tail -n 100 /var/log/nginx/error.log
  sudo tail -n 100 /var/log/nginx/access.log
  ```

**Pass criteria:** site stable; no 502; access log shows 200s.

### 5.3 Rollback drill (flip back to Blue)

```bash
cd /home/gdragos/proxy/nginx/upstreams
ln -sf backend-blue.conf  active_backend.conf
ln -sf frontend-blue.conf active_frontend.conf
sudo nginx -t && sudo systemctl reload nginx
```

* Validate again (browser + `curl`).
  **Pass criteria:** rollback immediate, stable.

---

## 6) Comprehensive End-to-End (E2E) Exercise

1. **Dev change** → CI builds, pushes images (check GHCR).
2. **Staging deploy** → Green pulls, restarts, migrates; `/healthz` 200; run a real API write and read (POST/GET `/users`).
3. **Production flip** → proxy points to Green; run the same write/read through the public/proxy endpoint; compare results with DB.
4. **Rollback** (optional): flip back to Blue; confirm continuity.
5. **Repeat** with another small change to build confidence and spot regressions.

---

## 7) Observability & Logs (collect evidence like a pro)

* **CI logs** — artifacts from the `ci` job show build logs and who pushed images.
* **CD logs (staging)** — SSH transcript shows `pull`, `restart`, health checks, and migration output.
* **Proxy logs** — `access.log`/`error.log` around flip time; keep screenshots or copies for your runbook.
* **Backend logs (app VM)** — `docker logs` around deployment and first traffic.

---

## 8) Typical Failure Patterns & Rapid Fixes

| Symptom                                                           | Likely Cause                                   | Fast Fix                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `manifest unknown` on pull                                        | No image pushed                                | Ensure CI “images” job pushes (`push: true`).                                   |
| 502 after flip                                                    | Proxy targeting wrong IP/port or backend crash | Validate upstream includes; curl target IP:3000/healthz; check backend logs.    |
| `password authentication failed`                                  | DB creds mismatch                              | Fix password on DB or rotate `app.env` on VM; restart service.                  |
| `required variable DB_* is missing` when running compose manually | You ran compose without env file               | Use systemd unit OR the `myapp-compose` wrapper that decrypts env to temp file. |
| Native nginx on App VM conflicts with port 80                     | Port already in use                            | Disable native nginx on **App VM** if frontend container must bind port 80.     |
| Prisma migration errors on deploy                                 | Drift or missing migration script              | Run `npx prisma migrate deploy` in backend container; fix schema or script.     |

---

## 9) Professor’s Mini-Quizzes (for mastery)

1. **Why** must CI push images even if you only “validate” build?
   *Because staging/production only pull—no push ⇒ no image available to pull.*

2. In blue/green, **what keeps rollback instant**?
   *Proxy flips are just symlink swaps and reloads; Blue remains intact until you deliberately retire it.*

3. Why not write `.env` to disk on the App VMs?
   *We use systemd-encrypted credentials so secrets are stored encrypted at rest and decrypted into RAM only during service start.*

4. What is the **first command** you run when you see a 502 after a flip?
   *From Proxy VM: `curl -is http://<ACTIVE_APP_IP>:3000/healthz | head -1` to isolate proxy vs backend.*

If you can answer those without peeking, you truly grok the system. 👏

---

## 10) Ready-Made Command Blocks (copy/paste)

### 10.1 CI verification (local)

```bash
docker login ghcr.io
docker pull ghcr.io/<owner>/myprojectappprod-backend:latest
docker pull ghcr.io/<owner>/myprojectappprod-frontend:latest
```

### 10.2 Staging quick health (Green VM)

```bash
systemctl status myproject-app --no-pager
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'

curl -is http://127.0.0.1:3000/healthz | head -1
curl -I  http://127.0.0.1/
```

### 10.3 Proxy flip (Proxy VM)

```bash
cd /home/gdragos/proxy/nginx/upstreams
ln -sf backend-green.conf  active_backend.conf
ln -sf frontend-green.conf active_frontend.conf
sudo nginx -t && sudo systemctl reload nginx
```

### 10.4 DB check from backend container (App VM)

```bash
BACK=$(docker ps --filter name=backend --format '{{.Names}}' | head -1)
docker exec -it "$BACK" sh -lc '
  PGPASSWORD="$DB_PASSWORD" psql "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME?connect_timeout=5" -c "SELECT 1;"
'
```

### 10.5 Apply Prisma migrations (App VM)

```bash
BACK=$(docker ps --filter name=backend --format '{{.Names}}' | head -1)
docker exec -it "$BACK" sh -lc 'npx prisma migrate deploy'
```

---

## 11) What to capture after each test (for your portfolio / audit)

* Screenshot of CI passing and GHCR images with timestamps.
* Staging CD logs + `systemctl status` + `/healthz` output.
* Proxy flip logs (`nginx -t`, `reload`, `access.log` slice).
* One end-to-end user flow through the proxy, including response time and status codes.
