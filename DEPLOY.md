# Deploying Clock-In

Three things get deployed: the API (Railway), the web dashboard (Vercel), and
the desktop installers (GitHub Releases). Neon already hosts the database and
Neon Auth, so neither needs deploying. DNS lives in **Azure DNS** for
`siqstack.com`.

| Piece | Runs at | Deployed by |
|---|---|---|
| API | `api.clock.siqstack.com` | Railway, from `apps/api/Dockerfile` |
| Web dashboard | `clock.siqstack.com` | Vercel, from `apps/web` |
| Desktop installers | GitHub Releases | `.github/workflows/release.yml`, on a tag |

Do these in order. The API has to exist before the other two can point at it.

---

## 1. API on Railway

The Railway CLI deploys straight from this repo (`railway.json` builds
`apps/api/Dockerfile` — no build settings to fill in):

```bash
railway login
railway init --name clock-in        # once, creates the project
railway add --service api           # once, creates the service
railway up --detach                 # builds the Docker image and deploys
```

Leave `PORT` alone; Railway injects it and the API reads it.

**Set these variables:**

```bash
railway variables \
  --set 'DATABASE_URL=<Neon → Clock-In → Connection Details → the unpooled/direct string>' \
  --set 'AUTH_BASE_URL=https://ep-tiny-mountain-ay0l41z3.neonauth.c-5.us-east-2.aws.neon.tech/neondb/auth' \
  --set 'NODE_ENV=production' \
  --set 'CORS_ORIGINS=https://clock.siqstack.com'
```

`NODE_ENV=production` makes the API reject any non-HTTPS CORS origin, so a
typo here fails loudly at boot rather than silently allowing plaintext.

**Add the domain:**

```bash
railway domain api.clock.siqstack.com
```

It prints the DNS records to create. **In Azure DNS** (portal → `siqstack.com`
zone → Record sets), add:

```
Type: CNAME  Name: api.clock                  Value: nnv28u39.up.railway.app
Type: TXT    Name: _railway-verify.api.clock  Value: railway-verify=460f44864d5f397c1c0c3f0d919d94280060ff7f9ef41435b7c98d5cb9c98863
```

Azure DNS does not proxy records, so Railway can issue its TLS certificate as
soon as the CNAME resolves. `railway domain status` shows progress.

**Run the migrations once**, from your machine, against production:

```bash
DATABASE_URL='<the same direct URL>' pnpm --filter @clock-in/database migrate
```

**Confirm:** `curl https://api.clock.siqstack.com/health` → `{"status":"ok"}`

---

## 2. Web dashboard on Vercel

The project `clock-in` is linked from `apps/web` (`.vercel/`) with these
Production environment variables — they are read at **build** time and baked
into the bundle, so changing one needs a redeploy, not a restart:

| Variable | Value |
|---|---|
| `VITE_AUTH_BASE_URL` | `https://ep-tiny-mountain-ay0l41z3.neonauth.c-5.us-east-2.aws.neon.tech/neondb/auth` |
| `VITE_API_BASE_URL` | `https://api.clock.siqstack.com` |

Deploy (build locally, upload the prebuilt output — no server-side build, so
the pnpm workspace just works):

```bash
cd apps/web
vercel build --prod
vercel deploy --prebuilt --prod
```

**Custom domain:** `clock.siqstack.com` is attached to the project. To activate
it, add these records in Azure DNS:

```
Type: TXT    Name: _vercel   Value: vc-domain-verify=clock.siqstack.com,723d1c2754d20297cd40
Type: CNAME  Name: clock     Value: cname.vercel-dns.com
```

The TXT record is Vercel's one-time proof that we own `siqstack.com`; once the
domain shows **Verified** in Vercel, the TXT can be removed.

`apps/web/vercel.json` sets the CSP and security headers. Its `connect-src`
names the API, auth, and GitHub API hosts explicitly — **if you change any of
those hostnames, edit that file too**, or the browser will block the requests.

---

## 3. Neon Auth

Neon → Clock-In → Auth → Configuration:

- **Add trusted origin:** `https://clock.siqstack.com`
- **Turn off "Allow localhost"** once you stop developing against it. Leaving it
  on in production widens what may redirect through your auth instance.

---

## 4. Desktop installers

The repo is public, so release assets are downloadable by anyone — the web
dashboard's **Download** button pulls the latest installer for the visitor's
platform straight from GitHub Releases.

Two **repository variables** are already set (Settings → Secrets and variables →
Actions → Variables), not secrets — they are baked into a public binary anyway:

| Variable | Value |
|---|---|
| `CLOCK_IN_AUTH_URL` | `https://ep-tiny-mountain-ay0l41z3.neonauth.c-5.us-east-2.aws.neon.tech/neondb/auth` |
| `CLOCK_IN_API_URL` | `https://api.clock.siqstack.com` |

Then tag a release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The workflow builds Windows and macOS installers and **publishes** the release
immediately, so the download links work as soon as the build finishes.

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
Deployments tab (`railway redeploy` also works). Migrations are additive so
far, so an older image runs against the current schema; that stops being true
the first time a migration drops a column. Vercel keeps every deployment too —
promote an earlier one from the project's Deployments tab.
