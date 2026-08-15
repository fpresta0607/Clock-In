# Deploying Clock-In

Three things get deployed: the API (Railway), the web dashboard (Vercel), and
the desktop installers (GitHub Releases). Neon already hosts the database and
Neon Auth, so neither needs deploying. DNS lives in **Azure DNS** for
`siqstack.com`.

| Piece | Runs at | Deployed by |
|---|---|---|
| API | `api.clock.siqstack.com` | Railway, from `apps/api/Dockerfile` |
| Web dashboard | `clock.siqstack.com` | Vercel, from `apps/web` |
| Desktop installers | GitHub Releases | Signed: `.github/workflows/release.yml`, on a tag. Unsigned, and what the site links today: `.github/workflows/unsigned-test-installers.yml`, on **Run workflow** |

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

### The exact command that ships the API, and what it changes

`railway up` uploads the working tree it is run from, so the directory and the
commit checked out in it *are* the deploy. Neither is inferred from GitHub, and a
feature branch left checked out will ship instead of `main`.

```bash
cd /home/fpresta0607/firstmate/projects/Clock-In   # the directory Railway is linked to
git checkout main && git pull                      # ship main, never a feature branch
git rev-parse --short HEAD                         # record what is going out
railway up --detach
```

What it changes: it builds `apps/api/Dockerfile` per `railway.json` and creates a
new deployment on service `api` (`f3f5e1de-4aef-4d5b-98ae-f521cd37c703`) in the
`production` environment, replacing whatever is live. It takes the API from a
build that answers `400` to `fromAt`/`toExclusiveAt` to one that accepts them,
which is the entire Reports and Leaderboard fix.

What it does not change: no variables, no domains, and no schema. Nothing
migrates on deploy, for the reason in the next section.

Confirm with the two calls above. The leaderboard call returning JSON instead of
`validation_error` is the fix landing. To roll back, redeploy the previous
deployment from the Railway dashboard; the schema changes are additive, and the
older build serves every route unchanged against the migrated schema.

### Migrate first, then deploy, and never the other way round

The API does not migrate on boot. `apps/api/src/server.ts` only opens a database
client, and `railway.json` sets no `preDeployCommand`, so `railway up` can never
apply a migration as a side effect. That is a safety property, not an oversight:
schema changes are yours to run deliberately, with the command under
"Run the migrations once" below.

It also means order matters, and only one order works. A build of `main` talking
to a database that is missing `time_sessions.attribution` answers `500` on both
report endpoints, because every report query selects that column. Deploying the
API before migrating therefore trades the `400` for a `500` and fixes nothing.
Run the migration, confirm it, then `railway up`.

### Production's migration journal has entries this repo no longer carries

`drizzle.__drizzle_migrations` in production records eleven migrations: the ten
it already held, plus this repo's `0009_user-view-preferences`, applied
directly after a Neon dry-run. Most match files in
`packages/database/migrations` by content hash; the rest do not. Three of the
mismatches are the migrations phase 3 applied and later rewrote in the repo
(`0007_browser_attribution`, `0008_browser_span_rules`, `0009_mapping_kind_check`),
so production already carries DDL that no file on `main` performs.

Drizzle decides what to apply by comparing `created_at` against each folder's
timestamp and never checks the hash, so it happily replays a chain that does not
match the database in front of it. Concretely, `0008_agent_runtime_roster`
re-adds `agent_sessions.rule_id`, which production already has, and the run stops
there:

```
Failed query: ALTER TABLE "agent_sessions" ADD COLUMN "rule_id" uuid;
```

The whole run is one transaction, so it rolls back cleanly and leaves the journal
untouched. Nothing is half-applied, but nothing is applied either.

Before migrating production, dry-run against a replica rather than trusting the
folder. Rebuild one from production's own journal, apply the repo's migrations,
and read the error:

```bash
psql "$PROD_DATABASE_URL" -c \
  'select hash, created_at from drizzle.__drizzle_migrations order by id'
# recreate that exact schema locally, then:
DATABASE_URL='postgres://…/replica' pnpm --filter @clock-in/database migrate
```

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

The repo is public, so release assets are downloadable by anyone. Until code
signing exists, the site's **Download for Windows** button does not point here:
it points at the `unsigned-latest` release described under *Unsigned test
installers* below.

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

Production release builds fail closed when signing credentials are missing —
`build.rs` and `src/release_signing.rs` gate every build. The release workflow
(`release.yml`) runs a signing preflight first: when no platform-signing
secrets are configured it skips the signed build job and dispatches the
unsigned installer publish instead, so a version tag never runs red (unsigned
is the project's accepted distribution today). Partial configuration still
fails hard. Local unsigned builds are explicit development-only builds and
cannot create production updater artifacts.

The certificates have days-to-weeks of identity-verification lead time, so
start procurement before the release, not after:

- **Windows:** an OV/EV code-signing certificate (~$200-600/yr)
- **macOS:** Apple Developer Program ($99/yr) for signing and notarization

The three desktop binaries (the app, `clock-in-hook`, and
`clock-in-browser-host`) sign with the same certificate. On Windows the
workflow imports the `.pfx` into the runner's certificate store, or uses the
configured store thumbprint directly, then signs the helpers with `signtool`
and configures Tauri to sign the app and installers with that thumbprint; on
macOS the bundler deep-signs everything inside the `.app` and notarizes it.

The helpers ship inside the installer via `externalBin` in
`apps/desktop/src-tauri/tauri.conf.json`: the workflow stages them as
`src-tauri/binaries/clock-in-hook-<target-triple>` and
`src-tauri/binaries/clock-in-browser-host-<target-triple>` before the bundler
runs, and the bundler installs them beside the app executable. That sibling
rule is how the app finds them at runtime — hook registration quotes the
`clock-in-hook` path beside the running app, and the native-messaging manifest
points at the `clock-in-browser-host` path beside it.

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

### Unsigned test installers

Before the signing certificates exist, `.github/workflows/unsigned-test-installers.yml`
builds the installers people actually download, and **it is what the website
hands out**. The build job still runs with read-only `contents` permission and
cannot publish anything; a separate `publish` job, which compiles nothing,
uploads what that job produced.

This is not a way around the signing gate — `build.rs` still classifies a
`--debug` build as development and keeps `createUpdaterArtifacts` off. When a
version tag has no signing configured, `release.yml` dispatches this workflow
automatically so every tag leaves something installable behind. It builds with `tauri build --debug`, which
`apps/desktop/src-tauri/build.rs` already classifies as a development build:
signing credentials are not required. `bundle.createUpdaterArtifacts` stays
off (`build.rs` refuses it for unsigned builds), but the workflow signs the
finished Windows installer with `tauri signer sign` and publishes a
`latest.json` manifest, so the updater works without touching the production
signing gate. Adding Azure Trusted Signing later changes `release.yml` only.

**To trigger it:** Actions → *Unsigned test installers* → **Run workflow**.
Because GitHub only offers *Run workflow* for workflows already on the default
branch, the workflow also runs on any push to a branch named
`unsigned-test/<anything>`, which is how you exercise a change to it before it
merges. A branch push **builds but does not publish**: only a deliberate *Run
workflow* replaces the public download, so exercising the workflow cannot
change what the website serves.

Windows ships the NSIS `...-setup.exe` only: WiX's `light.exe` cannot bundle
the unoptimized debug binary into an MSI, so that target is skipped here. The
tagged release still builds both.

#### The permanent download URL

A `workflow_dispatch` run force-updates the **`unsigned-latest` release** and
clobbers its assets, so these two URLs always serve the newest build and never
need touching:

```
https://github.com/fpresta0607/Clock-In/releases/download/unsigned-latest/Clock-In-UNSIGNED-TEST-windows-x64-setup.exe
https://github.com/fpresta0607/Clock-In/releases/download/unsigned-latest/Clock-In-UNSIGNED-TEST-macos-aarch64.dmg
```

`apps/web/src/DownloadInstaller.tsx` hard-codes exactly those strings, and
`DownloadInstaller.test.tsx` pins them, because renaming an asset on one side
alone silently 404s the button. This is why the assets carry fixed names rather
than the versioned ones inside the run artifact: the version travels in the
release title, the release notes, and the installed app, not in the URL.

**Do not** link a workflow-run artifact from anywhere public. GitHub requires
authentication to download one, so an artifact URL is a dead link for a
signed-out visitor. That is the whole reason for the fixed release.

The run artifacts (`UNSIGNED-TEST-BUILD-windows-<run number>` and `-macos-`)
still exist for branch pushes and for grabbing a build that was never
published. Inside are the installers under their versioned names, each prefixed
`UNSIGNED-TEST-`, plus an `UNSIGNED-TEST-BUILD.txt` recording the commit.

**Bump the version when the build changes.** `apps/desktop/src-tauri/tauri.conf.json`
holds the single `version`, and the installer, Add/Remove Programs, and the
release title all read from it. Leave it stale and a fresh build introduces
itself as the old one, which is how a same-day build got mistaken for four-day-old
software.

**Installing on Windows.** The installer is not signed, so SmartScreen shows a
blue *"Windows protected your PC / Windows Defender SmartScreen prevented an
unrecognized app from starting"* dialog with only a **Don't run** button. Click
**More info**, then **Run anyway**. The UAC prompt that follows names the
publisher as **Unknown**. Browsers may also flag the download itself: in Edge or
Chrome, open the downloads list and choose **Keep** on the blocked file. If the
file came through as a zip artifact, unblock it before extracting (right-click
the zip → Properties → **Unblock**), otherwise the mark-of-the-web propagates to
the installer.

Because these are debug builds, they are noticeably larger and slower than a
release build. The console window that once opened beside the app on Windows
has been fixed.

**Windows auto-update.** Once a build carrying the updater is installed, it
checks the `unsigned-latest` manifest at launch and every six hours, installs
a newer build quietly, and restarts. A build installed *before* the updater
shipped cannot update itself (its binary has no updater in it), so install
this build once by hand and every build after it is automatic. A signed
release cannot upgrade an unsigned install in place (different signing keys),
so uninstall the test build before installing a real release. macOS updates
are still by hand.

macOS installers are built by the same workflow. They are unsigned and
un-notarized, so Gatekeeper blocks them harder than SmartScreen does: after
mounting the `.dmg` and copying the app, clear the quarantine flag with
`xattr -dr com.apple.quarantine "/Applications/Clock-In.app"` before it will
launch.

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
