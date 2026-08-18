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

Reporting measures **active time** (the union of a person's working intervals — the
leaderboard headline, never exceeding wall clock), **agent time** (the summed agent
runtime, so parallel agents legitimately exceed active time), and **leverage**
(agent ÷ active); concurrency splits active time into t0/t1/t2/t3+ plus the agent
runtime that fell outside the person's presence. A session is still attributed whole
or not at all by `time_sessions.attribution`. The README's "How session tracking works"
section is the authoritative prose; keep it true when you change the model.

**Agent numbers belong to the agent.** The All-stats/board Humans tab answers for the person -
their active time and how many agents ran through it - and every measure of what the agents
themselves did lives on the Agents tab, under the picked roster agent: the runtime split, the
Agent-sessions table, the hourly chart, the codebases. "While they were there", "ran while away"
and leverage are measured against **that agent's owner's** presence, not the caller's, which is why
the paystub carries `ownerActiveSeconds` and `awaySeconds`. Do not move any of it back under a
person; a per-person fold reads as one worker's shifts when it is several.

A codebase reaches every member as a **label** - the last segment of a repo root or working
directory (`repoLabel`) - while the path itself stays under the `repoRoot` rule. A shift that
recorded no directory is `null` and reads "No codebase recorded"; there is no default codebase, just
as `resolveProjectForCwd` returns null rather than falling back to a project.

Agents are durable identities, not rows per run: one `agents` row per `(organization, owner, source,
repo_root)` — one person's harness working one codebase — and each `agent_sessions` row is one of its
shifts. The operator is the authenticated uploader, so the dimension costs each runtime nothing. A
null `repo_root` is that operator's unassigned bucket, a real roster row that several shifts share. A
bucket never claims a codebase in place: when a commit names one, `graduateAgentForSession` mints that
codebase's identity and re-stamps only the shift that produced the commit, because the bucket's other
shifts are not evidence of it. `project_id` stays on the row as a re-derivable attribute and never as
identity. A working directory named after a run rather than a codebase - a per-run worktree such as
`<hash>.git/worktrees/<ULID>` - names no codebase and identifies none, so its shifts land in that same
bucket instead of minting a row each (`repoLabel`, `identityRepoRoot`). Both partial uniques exclude retired rows, and
`upsertForKey`'s ON CONFLICT `targetWhere` must restate each index's predicate exactly - postgres
matches an arbiter to a partial index by that predicate, and a mismatch passes every mocked
repository and then fails every insert.
A model is an attribute of a shift, never an identity: `agent_sessions.model` says what the runtime
was driving, and neither it nor `source` is ever derived from the other. Browser spans are attention
rather than payroll, so `rosterEligibleSource` keeps them off the roster. Commits made during a
shift are captured at its end and verified later on the same machine
(`pending -> merged|reverted|orphaned`, terminal, never regressing).

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
spans **whole** - `SessionTracker` measures quiet time from the open idle span's
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
  installer is a `tauri build --debug` bundle
  (`.github/workflows/unsigned-test-installers.yml`), never a relaxed release build;
  `release.yml` fails hard on partial signing but skips (neutral) when no
  platform-signing secrets are configured — unsigned is the project's accepted
  distribution, and the workflow dispatches the unsigned installer publish instead.
  `src/release_signing.rs` stays fail-closed. Because the shipped
  installer is a *debug* build, never gate user-facing behaviour on
  `debug_assertions`: that condition is true in the artifact people download.
  `windows_subsystem` was gated that way and every install opened a console window
  behind the app.
- Desktop settings are read with `#[serde(default)]`, so removing a field is safe
  for existing installs, but *adding* one needs a sensible default or old files
  parse into something surprising.
- Migrations are generated, never hand-written: change `packages/database/src/schema.ts`,
  then `pnpm exec drizzle-kit generate --name <slug>` from `packages/database`. The
  snapshots under `migrations/meta` had drifted ahead of the SQL files, so a database
  built only from `migrations/*.sql` did not match `schema.ts` and `generate` - which
  diffs against the newest snapshot, never against a real database - could not see it.
  `0012_path_mapping_kind` closed the last of that drift, and CI now replays the whole
  chain against a PostgreSQL service container, which is what keeps it closed. Still read
  the emitted SQL before assuming it is only your change.
- The held rate is client-attested by design: `POST /shift-commits` records the desktop
  app's `verification` and `verified_at` as given and nothing corroborates them
  server-side (GitHub App/webhook corroboration was considered and rejected as a dead
  model). It is evidence about the work from the machine that did the work, so every surface saying "held"
  labels it that way - the paystub metric and README's roster section. Do not let it
  quietly become an input to pay without revisiting that decision.
- A repo root is a working directory, so `shiftCommitViewSchema.repoRoot` and the roster
  row's `agentSchema.repoRoot` go only to the agent's owner and workspace admins and are
  omitted - never blanked - for everyone else (`mayReadRepoRoot` in `services/agents.ts`);
  every member still gets the `repoName` label. The disclosure sentence naming what leaves the machine is
  stated in `apps/web/src/HelpModal.tsx`, `apps/desktop/src/RecordingPanel.tsx`
  and README's "What is never collected"; the three word it differently, but they must
  all describe the same thing that actually leaves the machine, so change what is sent
  and all three change with it.
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
  the uploader could see, and every agent event vanished silently. The browser host
  and the app share the same rule for `spool::browser_dir()`, so the two cannot
  drift apart the same way.
- `api.rs`'s `upload_agent_events` sends the explicit `AgentEventUpload` projection, never
  `SpoolEvent` itself: `agentSessionEventSchema` is `.strict()`, so serializing the spool
  struct would 400 every agent-event batch the moment it grew a local-only field, and
  `#[serde(skip_serializing)]` is not the escape hatch because the same impl writes the
  spool file. A new `SpoolEvent` field stays on the machine unless it is added to the
  projection deliberately; the uploader's exact-wire-bytes test pins the field set.
- Spool-derived evidence (`shift_commits`, and anything modeled on it) is captured
  from the uploader's `upload_once` pass on every platform - not the
  `#[cfg(windows)]`-gated spool replay - and uploads only after the agent-spool
  drains succeed that pass. `Started` and `Ended` lines can drain in different
  passes, so a persisted sidecar (`shift-windows.json`) carries the open window
  forward. A server rejection of `unknown_session` is retryable (the row stays
  unsynced); every other rejection is permanent.
- Bridge decoders show absence as absence: a stat the API may not send decodes to
  `null` and renders `-`, never 0 (the deployed API can be older than the desktop
  build). Background polls keep last-good data and surface a banner only after
  several consecutive failures or when there is no data at all - a single failed
  poll must never blip the UI.
- The API deploys before any installer can, so the desktop's response structs in
  `api.rs` never get a new required field: additive fields are always
  `#[serde(default)]`, and a renamed field decodes through a wire struct that
  accepts both spellings (`AgentsReportHeadcount` still reads the 0.1.7
  `anonymous`/`registered` headcount - a required `active` there is what
  dead-ended the Agents tab with "The server response could not be read." for
  every older installer when the rename deployed). The `bridge.ts` decoders hold
  the same line on the webview side: an absent field decodes to `null`/`[]`,
  never a crash.
- Claude Code's SessionStart/SessionEnd hook payloads carry no model key (verified
  live against Claude Code 2.1.233 on 2026-08-15: the payloads carry `session_id`,
  `transcript_path`, `cwd`, `hook_event_name`, and `source`/`reason` only; `model`
  is documented on the statusline JSON, not the session hooks). The payload's
  `transcript_path` is the repair path: every assistant entry in the transcript
  names its own model, so the desktop's transcript reader backfills it.
- The desktop force-installs the browser extension via the HKCU
  `ExtensionInstallForcelist` policy (`browser::sync_extension_policies`), but only
  when the store ids are compiled in (`CLOCK_IN_CHROME_EXTENSION_ID` /
  `CLOCK_IN_EDGE_EXTENSION_ID` repo vars), so nothing happens until the extension is
  published and the vars are set. `MonitorSettings.browser_auto_install` (default on)
  is the opt-out: removing the policy entry is what uninstalls the extension. Firefox
  has no force-install path until an AMO listing exists and keeps the manual flow.
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

`CLAUDE.md` is a pointer to this file: edit `AGENTS.md` only and never replace the pointer.
Plans live in `docs/plans/`; when one ships, prune it from here and fold the durable knowledge
it earned into the sections above.

Disambiguation: the agent-runtimes.json roster is runtime declarations; the `agents` table is worker identities.
