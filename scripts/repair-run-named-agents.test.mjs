import assert from "node:assert/strict";
import { test } from "node:test";

import { findCodebaseRow, foldsIntoBucket } from "./repair-run-named-agents.mjs";

function agent(overrides) {
  return {
    id: "8d1c2f7e-0000-4000-8000-00000000000a",
    repo_root: "C:/dev/siqshift",
    repo_key: "path:C:/dev/siqshift",
    status: "anonymous",
    ...overrides,
  };
}

// The regression: `repoLabel` keeps a directory's capitalisation and
// `normalizeRemote` lowercases a remote by design, so a capitalised checkout
// compared raw against its own remote-keyed row misses it - and the re-homing
// pass then mints a second `path:` row beside the correct one, splitting the
// repository inside the script that repairs split repositories.
test("a capitalised checkout re-homes onto its own remote-keyed row", () => {
  const repository = agent({ id: "row-remote", repo_root: "C:/w/clock-in-fix-login", repo_key: "github.com/acme/clock-in" });

  assert.equal(findCodebaseRow([repository], "Clock-In")?.id, "row-remote");
  assert.equal(findCodebaseRow([repository], "clock-in")?.id, "row-remote");
});

test("a second checkout under another spelling reaches the same repository row", () => {
  const repository = agent({ id: "row-remote", repo_root: "C:/dev/precisiondocs", repo_key: "github.com/fpresta0607/precisiondocs-ai" });

  assert.equal(findCodebaseRow([repository], "PrecisionDocs-AI")?.id, "row-remote");
});

test("the oldest matching row wins and an unrelated codebase never does", () => {
  const rows = [
    agent({ id: "older", repo_root: "C:/dev/Clock-In", repo_key: "path:C:/dev/Clock-In" }),
    agent({ id: "newer", repo_root: "C:/other/clock-in", repo_key: "path:C:/other/clock-in" }),
  ];

  assert.equal(findCodebaseRow(rows, "clock-in")?.id, "older");
  assert.equal(findCodebaseRow(rows, "pocket-piggies"), undefined);
});

// A row whose key names no codebase at all must not be matched by a label that
// happens to be absent on both sides.
test("a row with no codebase name matches nothing", () => {
  const opaque = agent({ id: "opaque", repo_root: "C:/w/dazzling-lamarr-0aacbd", repo_key: "path:C:/w/dazzling-lamarr-0aacbd" });

  assert.equal(findCodebaseRow([opaque], "clock-in"), undefined);
});

// The other half of the same rule: since 0016 the directory is evidence, not
// identity, so a gate worktree of a real repository is correctly keyed and
// folding it into the unassigned bucket would destroy that attribution.
test("a remote-keyed row is never folded, whatever its directory reads as", () => {
  const gateWorktree = "C:/Users/alex/.no-mistakes/repos/3245fe18a7c8.git/worktrees/01M06FSGP392MH6VJNRX8T364A";

  assert.equal(foldsIntoBucket(agent({ repo_root: gateWorktree, repo_key: "github.com/acme/clock-in" })), false);
  assert.equal(foldsIntoBucket(agent({ repo_root: gateWorktree, repo_key: `path:${gateWorktree}` })), true);
});

test("a row a member named, and a row whose directory names a codebase, are both left alone", () => {
  const run = "C:/w/dazzling-lamarr-0aacbd";

  assert.equal(foldsIntoBucket(agent({ repo_root: run, repo_key: `path:${run}`, status: "registered" })), false);
  assert.equal(foldsIntoBucket(agent()), false);
});
