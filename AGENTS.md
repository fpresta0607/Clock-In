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

## Sharp edges

- The Rust toolchain lives at `~/.cargo/bin` and may not be on `PATH`. Rust gate:
  `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`,
  all with `--manifest-path apps/desktop/src-tauri/Cargo.toml`.
- Desktop settings are read with `#[serde(default)]`, so removing a field is safe
  for existing installs, but *adding* one needs a sensible default or old files
  parse into something surprising.
- Migrations are generated, never hand-written: change `packages/database/src/schema.ts`,
  then `pnpm exec drizzle-kit generate --name <slug>` from `packages/database`. The
  drizzle snapshots under `migrations/meta` have drifted ahead of the SQL files, so a
  database built only from `migrations/*.sql` does not match `schema.ts`; a generated
  migration therefore picks up leftovers from earlier features. Check what a fresh
  `drizzle-kit generate` emits before assuming it is only your change.
- `clock-in-hook` and the desktop uploader must resolve the spool through the same
  `spool::agent_spool_path()`. When they disagreed, the hook exited 0, wrote nothing
  the uploader could see, and every agent event vanished silently.
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
