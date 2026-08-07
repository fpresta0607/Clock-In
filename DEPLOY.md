# Deploying Clock-In

Three things get deployed: the API (Railway), the web dashboard (Cloudflare
Pages), and the desktop installers (GitHub Releases). Neon already hosts the
database and Neon Auth, so neither needs deploying.

| Piece | Runs at | Deployed by |
|---|---|---|
| API | `api.clock.siqstack.com` | Railway, from `apps/api/Dockerfile` |
| Web dashboard | `clock.siqstack.com` | Cloudflare Pages, from `apps/web` |
| Desktop installers | GitHub Releases | `.github/workflows/release.yml`, on a tag |

Do these in order. The API has to exist before the other two can point at it.

---

## 1. API on Railway

**Create the service.** In Railway, add a project from this GitHub repo. It
reads `railway.json` and builds `apps/api/Dockerfile` — no build settings to
fill in. Leave `PORT` alone; Railway injects it and the API reads it.

**Set these variables** (Railway → service → Variables):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon → Clock-In → Connection Details → the **unpooled/direct** string |
| `AUTH_BASE_URL` | `https://ep-tiny-mountain-ay0l41z3.neonauth.c-5.us-east-2.aws.neon.tech/neondb/auth` |
| `NODE_ENV` | `production` |
| `CORS_ORIGINS` | `https://clock.siqstack.com` |

`NODE_ENV=production` makes the API reject any non-HTTPS CORS origin, so a
typo here fails loudly at boot rather than silently allowing plaintext.

**Add the domain.** Railway → Settings → Networking → Custom Domain →
`api.clock.siqstack.com`. Railway shows a CNAME target.

**In Cloudflare DNS**, add that record:

```
Type: CNAME   Name: api.clock   Target: <the target Railway shows>
Proxy: DNS only (grey cloud)
```

The grey cloud matters — Railway cannot issue its TLS certificate while
Cloudflare proxies the record. You can switch it to proxied later, once the
certificate is issued.

**Run the migrations once**, from your machine, against production:

```bash
DATABASE_URL='<the same direct URL>' pnpm --filter @clock-in/database migrate
```

**Confirm:** `curl https://api.clock.siqstack.com/health` → `{"status":"ok"}`

---

## 2. Web dashboard on Cloudflare Pages

Cloudflare → Workers & Pages → Create → Pages → connect this repo.

| Setting | Value |
|---|---|
| Build command | `pnpm install --frozen-lockfile && pnpm --filter @clock-in/web build` |
| Build output directory | `apps/web/dist` |
| Root directory | *(leave blank — the build needs the workspace)* |

**Environment variables** (Settings → Environment variables → Production):

| Variable | Value |
|---|---|
| `VITE_AUTH_BASE_URL` | `https://ep-tiny-mountain-ay0l41z3.neonauth.c-5.us-east-2.aws.neon.tech/neondb/auth` |
| `VITE_API_BASE_URL` | `https://api.clock.siqstack.com` |

These are read at **build** time and baked into the bundle, so changing one
needs a redeploy, not a restart.

**Custom domain:** Pages → Custom domains → `clock.siqstack.com`. Cloudflare
adds the DNS record itself.

`apps/web/public/_headers` sets the CSP and security headers. Its `connect-src`
names the API and auth hosts explicitly — **if you change either hostname, edit
that file too**, or the browser will block the requests.

---

## 3. Neon Auth

Neon → Clock-In → Auth → Configuration:

- **Add trusted origin:** `https://clock.siqstack.com`
- **Turn off "Allow localhost"** once you stop developing against it. Leaving it
  on in production widens what may redirect through your auth instance.

---

## 4. Desktop installers

Set two **repository variables** in GitHub (Settings → Secrets and variables →
Actions → Variables), not secrets — they are baked into a public binary anyway:

| Variable | Value |
|---|---|
| `CLOCK_IN_AUTH_URL` | `https://ep-tiny-mountain-ay0l41z3.neonauth.c-5.us-east-2.aws.neon.tech/neondb/auth` |
| `CLOCK_IN_API_URL` | `https://api.clock.siqstack.com` |

Then tag a release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The workflow builds Windows and macOS installers and opens a **draft** release.
Review it, then publish.

If those variables are missing, the build **fails** rather than shipping an
installer that points at localhost — `apps/desktop/src-tauri/build.rs` enforces
that.

### Code signing

Installers are unsigned, so Windows SmartScreen warns on download and macOS
refuses to open the app without right-click → Open. Fixing that needs paid
certificates:

- **Windows:** an OV/EV code-signing certificate (~$200–600/yr)
- **macOS:** Apple Developer Program ($99/yr) for signing and notarization

Both plug into `tauri-apps/tauri-action` via secrets. Worth doing before you
distribute widely; not required to install internally.

---

## Verifying a deploy

```bash
curl https://api.clock.siqstack.com/health          # {"status":"ok"}
curl -i https://api.clock.siqstack.com/me           # 401, no token
curl -i -X OPTIONS https://api.clock.siqstack.com/me \
  -H 'Origin: https://clock.siqstack.com' \
  -H 'Access-Control-Request-Method: GET'           # allow-origin echoes back
```

Then open `https://clock.siqstack.com`, create an account, and confirm the
workspace and invite code appear.

## Rolling back

Railway keeps previous deployments — redeploy an earlier one from the service's
Deployments tab. Migrations are additive so far, so an older image runs against
the current schema; that stops being true the first time a migration drops a
column.
