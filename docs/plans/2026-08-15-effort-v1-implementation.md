# Effort v1 implementation plan (shipped)

This plan shipped and is preserved here as the reasoning behind the code; the durable
knowledge it earned is folded into AGENTS.md. Where it says agent identity is keyed
`(org, source, project)`, agent identity v2 has since re-keyed it on
`(organization, owner, source, repo_root)` - see
[the agent identity v2 design](2026-08-16-agent-identity-v2-design.md).

## Context

Clock-In answers *how long*. Roster v1 made it answer *who worked*. Effort v1 makes it answer
*what that work cost* - and repairs the vocabulary that made the first answer unreadable.

Three problems, one root: the product measures how long an agent ran and nothing about what it
was or what it did.

**1. The product says "Claude Sonnet" and "Claude Code" are two agents.** Three surfaces use three
different notions of "agent" and none agree: the roster keys identity on `(org, source, project)`
("Claude Code @ Clock-In"); the Agent-sessions table folds by `(source, model)` and prints the
**model first** (`apps/desktop/src/App.tsx:189-193` renders `{split.model ?? sourceLabel(...)}`
with the runtime demoted to a hint); the live monitor rows are OS processes. So one Claude Code
shift renders as "claude-sonnet-4-5 · Claude Code" and another as "Claude Code" - two rows reading
as two workers. They are one worker: Claude Code is a harness running many sessions and sub-agents,
each driving a model. And "Register" (`apps/web/src/App.tsx:609-630`) restates the name and owner
the row already had, so it captures nothing and therefore means nothing.

**2. Coverage is real but invisible, and Claude Code probably records no model at all.**
`agent_sessions.source` is text with a shape check, so an undeclared runtime records fine, and
`model` rides beside it. But the Kimi/Grok/Muse/Copilot snippets pass no `--model`, and Claude
Code's native payload is mined for a top-level `model` key (`spool.rs:713-722`) that its
`SessionStart`/`SessionEnd` payloads are not documented to send - so the busiest runtime likely
stores `model = null` on every row. DeepSeek is correctly a *model*: it lands as
`source = "pi", model = "deepseek-v4-pro"` when Pi names it, and that separation stays.

**3. The graphs plot seconds, and seconds are a consumption number, not effort.** `HourlyGraph`
(`apps/web/src/App.tsx:210-255`, duplicated at `apps/desktop/src/App.tsx:206-251`) draws two flat
strokes of hardcoded hex: two gridlines, two y labels, no data points, no hover. Nothing in the
repo captures a token or a unit of compute - `quota.rs` reads percent-of-plan-remaining from the
`quota-axi` CLI and never leaves the device.

## User decisions (confirmed)

- **An agent is the harness per project.** Identity stays `(org, source, project)`; no schema
  change. Models become a breakdown inside an agent, never a peer row. "Register" goes away.
- **Tokens come from local session logs plus an explicit hook flag** - read the runtime's own
  transcript for usage numbers and model only, never a word of content, and give every other
  runtime hook flags to report directly. Needs a privacy disclosure and its own opt-out.
- **Honest gaps.** A `Time | Tokens` switch on the chart; the tokens view plots only what
  reported and names what did not. It never invents a zero.
- **Orchestrator parentage is out of scope** - document the `clock-in-hook` invocation a custom
  harness uses instead.

## What this deliberately does not do

No parent-session/run-id fleet model; no roster runtime for DeepSeek or any other *model*; no cost
or dollar figures (tokens are the unit, pricing is a moving target); no change to how time is
measured - active time stays a union, agent time stays a sum.

## Verified up front, not assumed

The Claude Code transcript format was read from a real file on this machine (keys only, no
content). One JSON object per line; assistant entries carry `timestamp`, `sessionId`, `cwd`,
`isSidechain`, `message.model`, and `message.usage` with `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens` (plus nested
`output_tokens_details.thinking_tokens`). **Sub-agents are separate files**: the main transcript is
`~/.claude/projects/<slug>/<sessionId>.jsonl` and each sub-agent writes
`<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` - same `sessionId`, `isSidechain: true`, its
own `agentId`, model and usage. The path is derivable from the hook's `transcript_path`, so
nothing is guessed, and summing the main file plus its `subagents/*.jsonl` siblings is what lets
the product say "Claude Code ran twelve agents on Opus 5 for 4.1M tokens".

---

## Step 0 - rewrite this section

Prune the shipped Roster v1 plan to the durable knowledge it earned (folded into the memory
sections above) and put this plan in its place. `CLAUDE.md` is a symlink to `AGENTS.md`; edit
`AGENTS.md` only and never replace the symlink. Commit alone.

## Step 1 - one vocabulary: the runtime is the worker, the model is what it drove

No migration. `agents.status` keeps all three values in the database; only what the product says
changes.

**Contracts** (`packages/shared/src/contracts.ts`): `agentsReportResponseSchema.headcount`
(:637-644) becomes `{total, active, retired}` - anonymous vs registered is no longer a distinction
anyone can act on. `agentPatchRequestSchema` keeps its fields, but only `"retired"` is reachable
from the UI; the API marks an agent `registered` itself the first time a member renames one (a name
someone chose *is* the registration). `agentPaystubResponseSchema` gains
`models: [{model|null, agentSeconds, shiftCount}]`; `agentsReportRowSchema` gains
`models: string[]`.

**API**: `services/agents.ts` folds the model mix from `listSessionsForAgent`
(`drizzle-repositories.ts:1324-1344`), which already selects `model` (group before summing, the
`reports.ts:265-267` rounding rule). `services/reports.ts` - `intervalsByAgentId` (:479-488)
currently discards `model` that `readAgentIntervals` already returns (:780); carry it instead.

**Both `AgentSessionsTable`s** (`apps/desktop/src/App.tsx:170-204`, `apps/web/src/App.tsx:176-208`)
- the fix actually asked for. Columns become **Runtime | Model | Sessions | Max at once | Total |
Median**: the runtime label leads, the model is its own column showing `-` when the hook named
none. The grouping key stays `(source, model)`; it stops pretending the model is the worker.

**Web roster** (:1079-1120): delete the Register button, `registerAgent` (:609-630) and the
`is-anonymous` grey class; add an inline **Rename**. Secondary line becomes
`runtime label · owner · model mix`. **Desktop roster** (:1554-1583) stays read-only and gains the
model mix; `bridge.ts` `decodeAgentsReportRow` (:757-780) grows `models`.

**Copy**: the paystub's rows are **shifts**, and one shift is one terminal session - say so, because
"Claude Code ran 40 shifts today" is confusing until you know the harness opens one per session.

## Step 2 - coverage: every terminal runtime, and the model it drove

`packages/shared/src/agent-runtimes.json` is the one declaration - change it there. Add `--model`
to every `manualSnippet` that can name one (Kimi Code, Grok, Muse, Copilot, opencode); where the
mechanism is genuinely unconfirmed the snippet keeps saying so. Add a declared
`reportsModel: "always" | "sometimes" | "never"` (zod-validated in `agent-runtimes.ts:25-49`; the
Rust struct has no `deny_unknown_fields`, so no Rust change is forced).

**Verify Claude Code's payload** before anything else: run a real session with the hook wired and
read the spool line. If `model` is absent, that is the finding - record it here, do not guess it.
**The repair** (lands with step 3): the transcript reader knows the model within seconds, so it
emits one model-bearing heartbeat, and the heartbeat path learns to fill a model it lacks. Today
`advanceLastEvent` (`services/agent-sessions.ts:179-183`) touches neither model nor agent - teach it
`model = coalesce(model, $new)`, mirroring the first-assignment-wins `agentId` coalesce at
`drizzle-repositories.ts:1122-1131`.

Desktop "AI tools" panel (`apps/desktop/src/App.tsx:1741-1780`): each connected runtime names the
models seen for it; each unconnected one says whether it reports a model at all.
`runtime_is_installed` stays a filesystem question (`monitor.rs:982-987`) - never a spawn, which
flashes a console. README's hooks table gains a "Reports model" column plus a **"Wiring up your own
orchestrator"** subsection with the literal invocation including the step-3 token flags.

## Step 3 - token capture: local session logs + explicit hook flags

Mirrors the shipped `shift_commits` subsystem end to end - the same problem: evidence discovered
late on the client, uploaded idempotently, tolerant of loss.

### Desktop (Rust)

- `spool.rs`: `SpoolEvent` gains `transcript_path: Option<String>` (from Claude Code's native
  payload, currently parsed-and-dropped at :711-712) and optional cumulative token counters.
  `EvidencePaths` / `evidence_paths_at` gain `agent_usage_path` (`agent-usage.json`) in the same
  (account, org) namespace.
- **A wire struct, and this one is a trap.** `api.rs:957-966` serializes `SpoolEvent` straight into
  the request body, and `agentSessionEventSchema` is `.strict()` - so the moment `SpoolEvent` grows
  a field, every agent-event batch 400s. A transcript path is not ours to send in any case, and
  `#[serde(skip_serializing)]` is not the fix because the same impl writes the spool file. Add an
  explicit borrow-and-project upload struct in `api.rs` carrying only the contract's fields, and
  pin it with an exact-wire-bytes test.
- New `src/agent_usage.rs`: a durable registry keyed `source|external_session_id` holding per-file
  read offset and identity (rotation/truncation detected, never double-counted) and
  per-`(hour bucket, model, sidechain)` counters with `client_id` / `synced` / `rejected`.
  `capture_from_spool` reads pending agent-spool lines *without* truncating, exactly as
  `shift_commits::capture_from_spool` does, and tails each transcript plus its `subagents/*.jsonl`
  siblings incrementally, parsing **only** usage numbers, model, timestamp and the sidechain flag.
  No line, prompt, tool argument, path or branch name is ever retained, logged, or uploaded.
- Caps and failure states, because a reader that can stall the uploader is worse than no reader:
  bounded bytes per file per pass (resume at the stored offset), the existing
  `MAX_SPOOL_RECORD_BYTES` line ceiling, a partially-written trailing line left unconsumed until
  complete, and a shrunken or replaced file read fresh rather than as a negative delta. Every
  failure is a state - the counters simply do not advance.
- `bin/clock-in-hook.rs`: new flags carrying **cumulative totals for the session so far**, not
  per-turn deltas. The spool can lose a record to a crash and a hook can fire twice; under both
  faults a cumulative number the registry takes the maximum of stays correct where summed deltas
  silently drift. An empty value reads as absent, as `--model` already does (:88-90).
- `uploader.rs` `upload_once`: capture runs beside `shift_commits::capture_from_spool` (:79), on
  every platform, driven by the upload pass rather than the `#[cfg(windows)]`-gated spool replay.
  Upload is gated on both agent-spool drains having succeeded; `"unknown_session"` rejections stay
  unsynced (retryable) and others are permanent - and that is exactly why the dance exists, because
  a usage bucket can be read before the `started` event that created its session was accepted.
- `monitor.rs` `MonitorSettings`: one `#[serde(default)]` bool, default **on**, mirroring
  `browser_auto_install` (:413, 424, 451-453, 466). Switching it off stops the reader; counts
  already captured are kept, as switching recording off keeps hours already earned.

### Database + API

Migration `agent_usage` (generated, then **read the emitted SQL** - the meta snapshots have drifted
and a fresh generate picks up leftovers). Columns: org, `user_id`, `agent_id` notNull,
`agent_session_id` notNull, `client_id`, `bucket_start_at`, `model` nullable, `sidechain` bool, and
the counters. Uniques `(org, user_id, client_id)` for replay and
`(org, agent_session_id, bucket_start_at, model, sidechain)` `.nullsNotDistinct()` for the bucket.

Contracts: `agentUsageUploadSchema` + batch (1..500) + `{accepted, rejected:[{clientId, reason}]}`,
cloned from `shiftCommitUploadSchema` (:655-668); `"unknown_session"` documented as retryable.
`services/agent-usage.ts` + `routes/agent-usage.ts` follow `services/shift-commits.ts` row by row,
including stamping an agent onto a session whose `agent_id` is still null. **Counters are bucket
totals upserted monotonically**, so re-reading a transcript region can only restate a number,
never add to it.

Rust tests follow the shipped templates - `shift_commits.rs`'s own tests and the `spool.rs`
lock/corruption suite (:2927-3025) for the sidecar, the `uploader.rs` stub-server suite (:418-657)
for ordering, retryability and exact wire bytes. Fixtures: a normal transcript, one grown between
passes, one truncated, one replaced, one with a half-written last line, one with a `subagents/`
sibling - plus a test asserting no captured struct has a field capable of holding message text.

## Step 4 - reporting effort, not just duration

`hourlyBucketSchema` (:155-167) gains nullable token fields. **Null is load-bearing**: it means
nothing in that hour reported tokens, which is what lets the chart break its line instead of
drawing a zero that never happened. `hourlySeries` (`reports.ts:227-254`) fills them on the same
local-hour tiling; active time stays a union, agent time stays a sum, tokens are a plain sum too
(parallel agents each spend their own). `meStatsResponseSchema`, `agentsReportRowSchema` and the
paystub gain token totals and a `tokensReported` flag; the paystub's `models` breakdown gains its
token split, which is the answer to "which model did the work". `/reports/agents` can then rank by
tokens as well as hours.

## Step 5 - the graphs: effort over time, with points you can read

Both apps keep their own copy of the component - `packages/shared` is imported by the API and must
not grow a React dependency - but the copies stay identical and the styling moves to tokens.

`packages/shared/styles/brand.css` gains the chart tokens it currently lacks (grid, axis, human,
agent, token-in/out, point, tooltip surface); every literal in the chart JSX (`#8b98a8`, `#00e59b`,
`#a3b3c2`, `rgba(163,179,194,.25)`, `.12`) becomes one. Single dark theme, no light theme to match.

`HourlyGraph` redesign: a `Time | Tokens` segmented switch in the existing `range-toggle` grammar
(`apps/web/src/App.tsx:767-790`), shown only when the range holds token data and naming the
runtimes that reported none; four labeled gridlines instead of two; **visible data points** - a dot
per bucket at day resolution, thinning to local extrema plus the hovered point at 30/90-day
resolution, so marks stay meaningful instead of becoming a bead curtain; a soft gradient area under
each series; a hover/focus crosshair with a tooltip naming the hour and each value; keyboard access
(focusable plot, arrow keys move the read-out, `aria-live` summary) where today there is a single
static `role="img"` label; and nulls that break the path rather than dropping it to the baseline.

The paystub trend (`apps/web/src/App.tsx:1179-1190`) is six weekly buckets rendered as text - the
most chart-shaped data in the product with no chart; it becomes a compact strip using the same
tokens. The desktop All-stats overlay gets the chart on both tabs (:1624-1683 renders none today).

**Tests that break deliberately**: `apps/web/src/App.test.tsx:470-494` and
`apps/desktop/src/App.test.tsx:700-724` assert *exactly two* `<path>` elements. Re-pin them to
per-series hooks (`[data-series="agent"]`) rather than a path count, which is what made them
brittle. `QuotaDial.test.tsx` is untouched.

## Cross-cutting

Commit per step (0-5); push with `git push -u origin claude/agent-session-tracking-aw82v3`
(retry 4x, exponential backoff, on network failure).

**Privacy is part of the deliverable, not a follow-up.** `RecordingPanel.tsx` KEPT (:48-53) gains a
line for token counts and models read from an AI tool's own session log; the NEVER line "Anything
inside your files, messages, or email." is amended exactly as commit titles were - the numbers are
the named exception. README's *What is never collected* and *Privacy* sections get the matching
sentences, and *How session tracking works* stays true.

**Deploy order** (manual; nothing deploys or migrates on merge): apply the migration deliberately,
dry-run against a replica built from production's own journal (DEPLOY.md); deploy the API (Railway)
before or with the web dashboard (Vercel), because the report filters are `.strict()`. Desktop
reaches users only through an installer release - bump `tauri.conf.json` once when that release is
cut. Never gate behavior on `debug_assertions`.

## Verification

Per step and at the end: `pnpm typecheck && pnpm test && pnpm build` from the root;
`~/.cargo/bin/cargo fmt --check`, `clippy --all-targets -- -D warnings`, `cargo test`, each with
`--manifest-path apps/desktop/src-tauri/Cargo.toml`. After `drizzle-kit generate`, read the emitted
SQL and prune drift leftovers. Integration suites when a disposable Postgres is available
(`TEST_DATABASE_URL=... pnpm test`); if none is, say so in the final report rather than skipping
silently.

**And by hand**: run a real Claude Code session against a wired hook, then confirm the spool line,
the registry file, the uploaded batch, a non-null model on the row, and a tokens series that draws.
A chart that plots is the only proof that matters here - the last hourly-graph bug shipped because
`polyline` was fed `path` geometry and every test still passed.
