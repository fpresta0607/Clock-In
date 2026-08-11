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

## Deploy the API and the web dashboard together

Nothing deploys on merge. Both are manual CLI pushes, so `main` being green says
only that the code builds, never that it is running. Whenever a change touches
`packages/shared`, redeploy **both** in the same sitting.

The two drift silently and the dashboard pays for it. The request filters are
`.strict()`, so a web bundle that sends a query parameter the running API has
never heard of gets a flat `400`, and the dashboard shows a red banner with no
hours. That is exactly how `fromAt`/`toExclusiveAt` broke the live workspace: the
web was redeployed, the API was not. A stale API also silently swallows the
desktop app's evidence, because `/sessions/observed` and `/activity/segments`
simply do not exist on it, so nobody's time is recorded either.

Check what is actually running before blaming the code:

```bash
curl -s https://api.clock.siqstack.com/health                 # is it up
curl -s -H "authorization: Bearer <jwt>" \
  'https://api.clock.siqstack.com/reports/leaderboard?fromAt=2026-01-01T00:00:00.000Z&toExclusiveAt=2026-01-02T00:00:00.000Z'
```

A `validation_error` from that second call means the API predates instant
bounds and needs `railway up`.

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

Set these **repository variables** (Settings → Secrets and variables → Actions →
Variables). They are baked into a public binary, so do not use secrets:

| Variable | Value |
|---|---|
| `CLOCK_IN_AUTH_URL` | `https://ep-tiny-mountain-ay0l41z3.neonauth.c-5.us-east-2.aws.neon.tech/neondb/auth` |
| `CLOCK_IN_API_URL` | `https://api.clock.siqstack.com` |
| `CLOCK_IN_CHROME_EXTENSION_ID` | Released Chrome Web Store ID, when available |
| `CLOCK_IN_EDGE_EXTENSION_ID` | Released Edge Add-ons ID, when available |
| `CLOCK_IN_FIREFOX_EXTENSION_ID` | Released Firefox add-on ID, when available |

Then tag a release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The workflow builds Windows and macOS installers and **publishes** the release
immediately, so the download links work as soon as the build finishes.

The API and auth URL variables are required: the build **fails** rather than
shipping an installer that points at localhost —
`apps/desktop/src-tauri/build.rs` enforces that. Extension IDs are optional
until their listings are released; without a valid ID, that browser's native
messaging integration stays disabled.

### Code signing and auto-update

Production release builds and the release workflow fail closed when Windows or
macOS signing credentials, notarization credentials, or the Tauri updater
signing key are missing. Local unsigned builds are explicit development-only
builds and cannot create production updater artifacts; a tagged release must
include signed installers and updater artifacts.

The certificates have days-to-weeks of identity-verification lead time, so
start procurement before the release, not after:

- **Windows:** an OV/EV code-signing certificate (~$200-600/yr)
- **macOS:** Apple Developer Program ($99/yr) for signing and notarization

Both desktop binaries (the app and `clock-in-hook`) sign with the same
certificate. `clock-in-browser-host` will ship with the phase-3 browser
extension; until that lands, only `clock-in-hook` is built. On Windows the
workflow imports the `.pfx` into the runner's certificate store, or uses the
configured store thumbprint directly, then signs the helper with `signtool`
and configures Tauri to sign the app and installers with that thumbprint; on
macOS the bundler deep-signs everything inside the `.app` and notarizes it.

The helper ships inside the installer via `externalBin` in
`apps/desktop/src-tauri/tauri.conf.json`: the workflow stages it as
`src-tauri/binaries/clock-in-hook-<target-triple>` before the bundler runs, and
the bundler installs it beside the app executable. That sibling rule is how the
app finds it at runtime — hook registration quotes the `clock-in-hook` path
beside the running app.

Set these under Settings → Secrets and variables → Actions → **Secrets**:

| Secret | Value |
|---|---|
| `WINDOWS_CERTIFICATE` | Base64 of the exported `.pfx` (`[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))`) |
| `WINDOWS_CERTIFICATE_PASSWORD` | The `.pfx` export password |
| `WINDOWS_TIMESTAMP_URL` | Optional RFC 3161 timestamp server; defaults to `http://timestamp.digicert.com` |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | Optional; use instead of the `.pfx` pair when the certificate already lives in the runner's store (Azure Key Vault / SafeNet flow) |
| `APPLE_CERTIFICATE` | Base64 of the exported Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application signing identity |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_PASSWORD` | App-specific password for that Apple ID (from appleid.apple.com) |
| `APPLE_TEAM_ID` | The 10-character team id |
| `TAURI_SIGNING_PRIVATE_KEY` | The updater private key from `pnpm tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password chosen when generating that key |

The workflow always enables `bundle.createUpdaterArtifacts`, so the release
carries the updater signatures and `latest.json` beside the installers, which
is what the in-app updater verifies against. The matching public key goes into
the updater config in
`apps/desktop/src-tauri/tauri.conf.json`. Back the private key up somewhere
durable: losing it means existing installs can never verify an update again.

---

## 5. Browser extension stores

Chrome on Windows stable does not sideload extensions, so the extension ships
through the stores: Chrome Web Store (unlisted) and Edge Add-ons. Every CI
run attaches the built packages as the `browser-extension-store-zips`
artifact (the Chrome/Edge zip and the Firefox variant zip from
`apps/browser-extension/release/`); download it from the run page to submit.

**Chrome Web Store (unlisted):**

1. Create a developer account at the Chrome Web Store dashboard ($5 one-time).
2. Add a new item and upload the Chrome/Edge zip from the CI artifact.
3. Set visibility to **Unlisted**, so only people with the link can install.
4. The `tabs` permission shows as "read your browsing history" in the install
   warning, so the listing text must state plainly what leaves the browser:
   rule verdicts and timestamps only, never URLs or history.
5. Submit for review. Once approved, the store assigns the extension id;
   that id is what the desktop's store links and the native-messaging
   manifest's `allowed_origins` pin against.

**Edge Add-ons:**

1. Create a Microsoft Partner Center developer account.
2. Submit the same Chrome/Edge zip under Edge Add-ons with the same listing
   copy; Edge runs the same engine and accepts the same package.
3. Same id step as Chrome once approved.

After each store approves its listing, set the corresponding
`CLOCK_IN_*_EXTENSION_ID` repository variable before building the next desktop
release. The ID is compiled into that release's native-messaging manifest. A
missing or invalid ID leaves that browser disabled and removes Clock-In's
native-messaging registration, so pre-release placeholder IDs never authorize
a production host.

**Review latency is part of the release cadence.** Every submission queues
for human review, from hours to days for Chrome and up to a week for Edge,
and a rejected listing restarts the clock. Submit the extension before or
alongside tagging a desktop release that depends on it, and never announce a
feature that is still in review.

**Firefox** needs its own signed build and its own native-messaging manifest
path; ship Chrome/Edge first and submit Firefox when demand exists.

**Managed fleets** skip the two store clicks entirely via the browsers' own
force-install policy. Add
`<extension-id>;https://clients2.google.com/service/update2/crx` to
`ExtensionInstallForcelist` in the registry:

- Chrome: `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist`
- Edge: `HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist`

Force-install still pulls the package from the store update URL, so the
listing must exist and stay published even when every install is managed.

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
