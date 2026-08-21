import assert from "node:assert/strict";
import { test } from "node:test";

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ownerArgument, planRepair, remoteProbeFailure, resolveKey } from "./repair-agent-identity-by-remote.mjs";

const organization = "8d1c2f7e-0000-4000-8000-000000000001";
const owner = "8d1c2f7e-0000-4000-8000-000000000002";

function agent(overrides) {
  const row = {
    id: "8d1c2f7e-0000-4000-8000-00000000000a",
    organization_id: organization,
    owner_user_id: owner,
    source: "claude_code",
    repo_root: "C:/dev/api",
    repo_key: null,
    name: "Claude Code @ api",
    status: "anonymous",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    owner_name: "Alex",
    shifts: 3,
    commits: 2,
    usage_rows: 1,
    ...overrides,
  };
  // Every live row carries a key by the time this runs: 0016's backfill gave
  // the ones that predate it `path:<root>`, which is the identity they had.
  return row.repo_key === null && row.repo_root !== null ? { ...row, repo_key: `path:${row.repo_root}` } : row;
}

/** A machine that holds only the checkouts named here; anything else is not on it. */
const machine = (checkouts) => (row) => checkouts[row.repo_root]
  ?? { key: `path:${row.repo_root}`, status: "unreadable", detail: "no such directory on this machine" };

const remote = (key) => ({ key, status: "remote", detail: key });
const localOnly = (root) => ({ key: `path:${root}`, status: "local-only", detail: "the checkout is here and has no origin remote" });

// The regression: the documented workflow is for each operator to run this on
// their own machine, so on operator B's machine every one of operator A's rows
// is a directory that does not exist. Grouping those rows under the path key
// this machine cannot verify re-keyed them from their remote back to A's
// directory - splitting A's repository across its worktrees again, which is
// exactly the defect the script exists to undo. It also broke idempotency: a
// row folded onto its remote on run 1 was demoted on run 2 once its worktree
// had been deleted.
test("a row whose checkout is not on this machine is left entirely alone", () => {
  const stranger = agent({
    id: "8d1c2f7e-0000-4000-8000-00000000000b",
    repo_root: "D:/operator-a/worktrees/api-1",
    repo_key: "github.com/acme/api",
    owner_name: "Blake",
  });

  const plan = planRepair([stranger], machine({}));

  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.rekeys, []);
  assert.deepEqual(plan.ambiguous, []);
  assert.deepEqual(plan.localOnly, []);
  assert.deepEqual(plan.refusals.map((refusal) => refusal.agent.id), [stranger.id]);
});

// The worse variant of the same bug: an unreadable row that lands in a group
// is not merely re-keyed, it is merged - into whichever live row happens to
// sit at the same path on this machine.
test("an unreadable row is never merged into a live row that shares its path", () => {
  const absent = agent({
    id: "8d1c2f7e-0000-4000-8000-00000000000b",
    repo_key: "github.com/acme/api",
    shifts: 40,
  });
  const here = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000c" });

  const plan = planRepair([absent, here], (row) => (row.id === here.id
    ? localOnly(here.repo_root)
    : { key: `path:${row.repo_root}`, status: "unreadable", detail: "no such directory on this machine" }));

  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.rekeys, []);
  assert.deepEqual(plan.localOnly.map((entry) => entry.agent.id), [here.id]);
  assert.deepEqual(plan.refusals.map((refusal) => refusal.agent.id), [absent.id]);
});

// The other route to the same demotion: the checkout is here, but its origin
// was removed after the row had already been keyed on that remote.
test("a remote-keyed row whose origin has gone is refused, not demoted to its directory", () => {
  const row = agent({ repo_key: "github.com/acme/api" });

  const plan = planRepair([row], machine({ "C:/dev/api": localOnly("C:/dev/api") }));

  assert.deepEqual(plan.rekeys, []);
  assert.deepEqual(plan.merges, []);
  assert.equal(plan.refusals.length, 1);
});

test("a local-only row keeps the directory it is already keyed on, and writes nothing", () => {
  const row = agent({ repo_root: "C:/dev/scratchpad" });

  const plan = planRepair([row], machine({ "C:/dev/scratchpad": localOnly("C:/dev/scratchpad") }));

  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.rekeys, []);
  assert.deepEqual(plan.localOnly.map((entry) => entry.agent.id), [row.id]);
});

test("two worktrees of one remote fold onto the older row, and a lone row is re-keyed", () => {
  const key = "github.com/acme/api";
  const first = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000b", repo_root: "C:/w/api-1", created_at: new Date("2026-01-01T00:00:00.000Z") });
  const second = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000c", repo_root: "C:/w/api-2", created_at: new Date("2026-02-01T00:00:00.000Z") });
  const alone = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000d", repo_root: "C:/dev/web", source: "codex" });

  const plan = planRepair([first, second, alone], machine({
    "C:/w/api-1": remote(key),
    "C:/w/api-2": remote(key),
    "C:/dev/web": remote("github.com/acme/web"),
  }));

  assert.equal(plan.merges.length, 1);
  assert.equal(plan.merges[0].key, key);
  assert.equal(plan.merges[0].winner.id, first.id);
  assert.deepEqual(plan.merges[0].losers.map((loser) => loser.id), [second.id]);
  assert.deepEqual(plan.rekeys.map((rekey) => [rekey.agent.id, rekey.key]), [[alone.id, "github.com/acme/web"]]);
});

// The hole that making unreadable rows inert opened: the row we refuse still
// holds its key, and the partial unique covers exactly the live rows, so any
// write of that key raises a unique violation - after earlier merges have
// already committed, which is the half-applied repair the script exists to
// prevent. The row is inert in both directions: not re-keyed past, and not
// merged into either, because receiving another row's shifts is not inert.
test("a single row is not re-keyed onto a key a live row it cannot read holds", () => {
  const key = "github.com/acme/api";
  const holder = agent({
    id: "8d1c2f7e-0000-4000-8000-00000000000b",
    repo_root: "D:/gone/api",
    repo_key: key,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  });
  const here = agent({
    id: "8d1c2f7e-0000-4000-8000-00000000000c",
    repo_root: "C:/dev/api",
    created_at: new Date("2026-03-01T00:00:00.000Z"),
  });

  const plan = planRepair([holder, here], machine({ "C:/dev/api": remote(key) }));

  assert.deepEqual(plan.rekeys, []);
  assert.deepEqual(plan.merges, []);
  assert.equal(plan.contended.length, 1);
  assert.equal(plan.contended[0].key, key);
  assert.deepEqual(plan.contended[0].members.map((member) => member.id), [here.id]);
  assert.equal(plan.contended[0].holder.id, holder.id);
});

// The branch the guard missed: a merge re-keys its winner with the very same
// statement, so a group of two present worktrees walks into the same unique
// violation - and this is the dominant shape in the reported data, five
// worktrees of one repository.
test("a merge is not queued when a live row it cannot read holds the group's key", () => {
  const key = "github.com/acme/api";
  const holder = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000b", repo_root: "D:/gone/api", repo_key: key });
  const first = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000c", repo_root: "C:/w/api-1" });
  const second = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000d", repo_root: "C:/w/api-2" });

  const plan = planRepair([holder, first, second], machine({
    "C:/w/api-1": remote(key),
    "C:/w/api-2": remote(key),
  }));

  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.rekeys, []);
  assert.equal(plan.contended.length, 1);
  assert.deepEqual(plan.contended[0].members.map((member) => member.id).sort(), [first.id, second.id].sort());
  assert.equal(plan.contended[0].holder.id, holder.id);
});

// A holder need not have a repo root at all: a remote can identify a row when
// no directory was reported, and such a row never becomes a candidate, so it
// has to be read for the key it holds rather than skipped outright.
test("a rootless row still holds its key against the group that resolves to it", () => {
  const key = "github.com/acme/api";
  const rootless = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000b", repo_root: null, repo_key: key });
  const here = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000c", repo_root: "C:/dev/api" });

  const plan = planRepair([rootless, here], machine({ "C:/dev/api": remote(key) }));

  assert.deepEqual(plan.rekeys, []);
  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.contended.length, 1);
  assert.equal(plan.contended[0].holder.id, rootless.id);
});

// The operator's unassigned bucket has no root to probe and no key to hold, so
// it is neither a candidate nor a refusal - it simply is not this run's work.
test("the unassigned bucket is not a candidate and not reported as refused", () => {
  const bucket = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000b", repo_root: null, repo_key: null });

  const plan = planRepair([bucket], machine({}));

  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.rekeys, []);
  assert.deepEqual(plan.refusals, []);
  assert.deepEqual(plan.contended, []);
});

// A second run sees keys that are already right and has nothing left to do.
test("a run over an already repaired roster is a no-op", () => {
  const key = "github.com/acme/api";
  const row = agent({ repo_key: key });

  const plan = planRepair([row], machine({ "C:/dev/api": remote(key) }));

  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.rekeys, []);
  assert.deepEqual(plan.refusals, []);
});

// A name a member chose is not this script's to drop, so a group holding two
// of them is refused whole rather than picking one.
test("a group with two names a member chose is refused rather than merged", () => {
  const key = "github.com/acme/api";
  const mine = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000b", repo_root: "C:/w/api-1", status: "registered", name: "Alex's helper" });
  const theirs = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000c", repo_root: "C:/w/api-2", status: "registered", name: "Reviewer" });

  const plan = planRepair([mine, theirs], machine({ "C:/w/api-1": remote(key), "C:/w/api-2": remote(key) }));

  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.rekeys, []);
  assert.equal(plan.ambiguous.length, 1);
});

// Reading every git failure as "this repository has no remote" turns "we
// cannot say" into a claim, and a local-only row does take part in the
// grouping and does get written. It also empties the refusals section, which
// is the script's only way of saying "run this from the machine that holds
// these checkouts" - so a probe that never worked reads as nothing to repair.
test("only git's key-not-set exit means the checkout has no origin", () => {
  assert.equal(remoteProbeFailure({ status: 1 }).status, "local-only");
});

test("a checkout git refused to read stays unreadable, and says why", () => {
  // Exit 128 is `fatal: detected dubious ownership in repository`, git's
  // ordinary refusal when a checkout's owner is not the running user.
  const refused = remoteProbeFailure({
    status: 128,
    stderr: "fatal: detected dubious ownership in repository at 'C:/dev/api'\nowner is someone else\n",
  });

  assert.equal(refused.status, "unreadable");
  assert.match(refused.detail, /128/);
  assert.match(refused.detail, /dubious ownership/);
  assert.doesNotMatch(refused.detail, /owner is someone else/);
});

test("git missing from PATH and a timed-out probe are both unreadable", () => {
  assert.equal(remoteProbeFailure({ code: "ENOENT" }).status, "unreadable");
  assert.equal(remoteProbeFailure({ status: null, signal: "SIGTERM" }).status, "unreadable");
  assert.match(remoteProbeFailure({ code: "ENOENT" }).detail, /PATH/);
  assert.match(remoteProbeFailure({ status: null, signal: "SIGTERM" }).detail, /SIGTERM/);
});

// The three states the report rests on, read from real directories rather
// than from a mapping: `config --get` without `--local` is the one git
// subcommand that does not fail outside a repository, so a pruned worktree
// whose folder was left behind would be reported as a healthy repository with
// no remote - and the refusals section, which is the operator's only signal to
// run this elsewhere, would stay silent about it.
test("resolveKey separates a non-repository, a remote-less repository and a remote", () => {
  const scratch = mkdtempSync(join(tmpdir(), "clock-in-resolve-key-"));
  const globalConfig = join(scratch, "gitconfig-global");
  // The hazard made deterministic: exactly the key the probe reads, set where
  // a bare `config --get` would fall through to. Handed to the probe's child
  // process rather than set on this one.
  writeFileSync(globalConfig, '[remote "origin"]\n\turl = https://github.com/someone/unrelated.git\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    const plain = join(scratch, "not-a-repo");
    mkdirSync(plain);
    assert.equal(resolveKey({ repo_root: plain }, env).status, "unreadable");

    const bare = join(scratch, "no-origin");
    mkdirSync(bare);
    git(bare, ["init", "--quiet"]);
    assert.equal(resolveKey({ repo_root: bare }, env).status, "local-only");

    const pushed = join(scratch, "with-origin");
    mkdirSync(pushed);
    git(pushed, ["init", "--quiet"]);
    git(pushed, ["remote", "add", "origin", "git@github.com:acme/api.git"]);
    assert.deepEqual(
      { key: resolveKey({ repo_root: pushed }, env).key, status: resolveKey({ repo_root: pushed }, env).status },
      { key: "github.com/acme/api", status: "remote" },
    );

    const absent = join(scratch, "never-existed");
    assert.equal(resolveKey({ repo_root: absent }, env).status, "unreadable");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The scoping guard, at the one boundary it has to hold: presence on disk says
// only "I can read what this row points at", never "this row is mine". Two
// operators can each keep a different repository at `C:/dev/api`, so an
// unscoped `--confirm` can re-key - and, where the other operator already
// holds that remote, merge away - a row belonging to someone else.
test("--owner is read from either spelling, and its absence is not an empty value", () => {
  assert.equal(ownerArgument(["node", "s.mjs", "--owner", "you@example.com"]), "you@example.com");
  assert.equal(ownerArgument(["node", "s.mjs", "--owner=you@example.com", "--confirm"]), "you@example.com");
  assert.equal(ownerArgument(["node", "s.mjs", "--confirm"]), undefined);
  // Named nobody, which is not everybody: `--confirm` refuses this too.
  assert.equal(ownerArgument(["node", "s.mjs", "--owner", "--confirm"]), "");
  assert.equal(ownerArgument(["node", "s.mjs", "--owner"]), "");
});

test("--confirm without --owner refuses before it opens the database", () => {
  const script = fileURLToPath(new URL("./repair-agent-identity-by-remote.mjs", import.meta.url));
  // A port nothing listens on: reaching the database at all fails loudly and
  // slowly, so a clean exit 2 is proof the refusal came first.
  let failed;
  assert.throws(() => execFileSync(process.execPath, [script, "--confirm"], {
    env: { ...process.env, DATABASE_URL: "postgres://127.0.0.1:1/nowhere" },
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
  }), (error) => {
    failed = error;
    return true;
  });

  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /--confirm requires --owner/);
  assert.doesNotMatch(failed.stderr, /ECONNREFUSED/);
});
