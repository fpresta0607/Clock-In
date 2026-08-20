import assert from "node:assert/strict";
import { test } from "node:test";

import { planRepair } from "./repair-agent-identity-by-remote.mjs";

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
  return row.repo_key === null ? { ...row, repo_key: `path:${row.repo_root}` } : row;
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
// holds its key, and the partial unique is on live rows, so re-keying another
// row onto it raises a unique violation - after earlier merges have already
// committed, which is the half-applied repair the script exists to prevent.
// Two rows proven to be one repository is a merge, not a collision.
test("a re-key that would collide with a live row becomes a merge instead", () => {
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
  assert.equal(plan.merges.length, 1);
  assert.equal(plan.merges[0].key, key);
  assert.equal(plan.merges[0].winner.id, holder.id);
  assert.deepEqual(plan.merges[0].losers.map((loser) => loser.id), [here.id]);
  // The row drawn into that merge is no longer reported as untouched.
  assert.deepEqual(plan.refusals, []);
});

test("a collision between two names a member chose is refused, not merged", () => {
  const key = "github.com/acme/api";
  const holder = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000b", repo_root: "D:/gone/api", repo_key: key, status: "registered", name: "Reviewer" });
  const here = agent({ id: "8d1c2f7e-0000-4000-8000-00000000000c", status: "registered", name: "Alex's helper" });

  const plan = planRepair([holder, here], machine({ "C:/dev/api": remote(key) }));

  assert.deepEqual(plan.merges, []);
  assert.deepEqual(plan.rekeys, []);
  assert.equal(plan.ambiguous.length, 1);
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
