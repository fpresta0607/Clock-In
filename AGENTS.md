# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## The product model, so you don't restore a dead one

**There is no manual timer.** Recording is automatic: the OS monitor's own
working/idle/locked/suspended boundaries open and close sessions, and the consent
toggle (`MonitorSettings.enabled`, on by default) is the product's only on/off.
Anything that reads like start/stop, an away prompt, a suggested start, or a
running-timer conflict belongs to the retired model. `POST /sessions`,
`/sessions/:id/stop`, and `/sessions/current` still exist but are deprecated and
called by nothing shipped; the live write path is `POST /sessions/observed`.
Legacy rows keep `attribution = 'manual'` and are never rewritten.

Reporting splits totals into **attributed** and **unattributed** seconds, not
verified and unverified. A session is attributed whole or not at all, by
`time_sessions.attribution`. The README's "How session tracking works" section is
the authoritative prose; keep it true when you change the model.

## The agent-runtime roster is data, not code

`packages/shared/src/agent-runtimes.json` is the single declaration of every runtime
Clock-In knows by name. The TypeScript side imports it; the Rust host embeds the same
file (`apps/desktop/src-tauri/src/agent_runtimes.rs`), so the two cannot drift. Add a
runtime there, not in six places.

It is a roster, **not an allowlist**: `agent_sessions.source` is text with a shape
check, so an undeclared runtime is still recorded under its own id. Never reintroduce
an enum for it, and never map an unknown runtime onto `other`.

A runtime is identified by the registration that fired, never by the payload's shape:
Codex pipes Claude Code's exact hook payload, so registrations pass `--source`. And
runtime and model are independent — neither is ever derived from the other.

## What actually closes a segment

`SegmentBuilder::apply` is the whole capture path, and three things end an
active span: a change of state, a change of the app in front, and
`MAX_OPEN_ACTIVE_SECONDS`. Only the first existed once, and it is why
`activity_segments` was empty in production for the app's whole life: a machine
in continuous use never changes state, so one span sat in memory and the spool
file was never created. If you touch the fold, keep all three, and keep idle
spans **whole** — `SessionTracker` measures quiet time from the open idle span's
start, so splitting one stops sessions ever closing.

`running` means "the tasks were started"; `observing` means "polls are still
landing". A poll task that panics leaves its `JoinHandle` in place, so only
`observing` may be read as recording. `recordingState` in `RecordingPanel.tsx`
is the single derivation every surface reads, and each surface's wording comes
from a table keyed by it. Do not re-derive it locally: that is exactly how the
timer once said RECORDING above a card reading "Turn on recording in settings".

## Sharp edges

- The Rust toolchain lives at `~/.cargo/bin` and may not be on `PATH`. Rust gate:
  `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`,
  all with `--manifest-path apps/desktop/src-tauri/Cargo.toml`.
- `build.rs` treats *any* build with `debug_assertions` off as a production artifact
  and demands the updater key plus platform signing credentials. So an unsigned
  installer is a `tauri build --debug` bundle. Because the shipped installer is a
  *debug* build, never gate user-facing behaviour on `debug_assertions` — that
  condition is true in the artifact people download. `windows_subsystem` was gated
  that way and every install opened a console window behind the app.
  (`.github/workflows/unsigned-test-installers.yml`), never a relaxed release build;
  `release.yml` and `src/release_signing.rs` stay fail-closed.
- Desktop settings are read with `#[serde(default)]`, so removing a field is safe
  for existing installs, but *adding* one needs a sensible default or old files
  parse into something surprising.
- Migrations are generated, never hand-written: change `packages/database/src/schema.ts`,
  then `pnpm exec drizzle-kit generate --name <slug>` from `packages/database`. The
  drizzle snapshots under `migrations/meta` have drifted ahead of the SQL files, so a
  database built only from `migrations/*.sql` does not match `schema.ts`; a generated
  migration therefore picks up leftovers from earlier features. Check what a fresh
  `drizzle-kit generate` emits before assuming it is only your change.
- The migration folder is not a description of production. Production's
  `drizzle.__drizzle_migrations` holds entries whose hashes match no file on `main`,
  because phase 3 applied migrations that were later rewritten here. Drizzle selects
  work by `created_at` alone and never verifies a hash, so the chain replays onto a
  schema it was not generated against and stops on the first collision. Dry-run against
  a replica built from production's journal before migrating it; see "Production's
  migration journal has entries this repo no longer carries" in `DEPLOY.md`. Nothing
  migrates on deploy, so this is always a deliberate, separate step.
- `clock-in-hook` and the desktop uploader must resolve the spool through the same
  `spool::agent_spool_path()`. When they disagreed, the hook exited 0, wrote nothing
  the uploader could see, and every agent event vanished silently.
- The site's **Download for Windows** button is a hard-coded
  `releases/download/unsigned-latest/<fixed asset name>` URL, kept true by the `publish`
  job in `unsigned-test-installers.yml`. That job runs on `workflow_dispatch` only, so a
  `unsigned-test/**` push builds without touching what the public downloads. Rename an
  asset on one side alone and the button 404s silently; `DownloadInstaller.test.tsx` pins
  both names. Never link a workflow-run artifact publicly: downloading one needs auth.
  The app version lives only in `apps/desktop/src-tauri/tauri.conf.json` and nothing bumps
  it for you, so a fresh build will introduce itself as the last version you shipped.
- Both frontends share `packages/shared/styles/brand.css` and ship a single dark
  theme; there is no light theme to match, so use the tokens rather than literals.
- Nothing deploys on merge. The API (Railway) and the web dashboard (Vercel) are
  separate manual pushes, so production can run two different commits of
  `packages/shared`. Because the report filters are `.strict()`, a newer web
  bundle sending a parameter an older API does not declare gets a bare `400`.
  Check what is deployed before debugging a live report failure; see
  "Deploy the API and the web dashboard together" in `DEPLOY.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
