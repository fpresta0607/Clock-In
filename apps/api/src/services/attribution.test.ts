import { describe, expect, it } from "vitest";

import {
  agentCodebaseLabel,
  identityRepoKey,
  identityRepoRoot,
  normalizePath,
  normalizeRemote,
  repoKeyLabel,
  repoLabel,
  resolveProjectForCwd,
  resolveProjectForRule,
  type PathMappingCandidate,
} from "./attribution.js";

const projectA = "a1c7e513-b094-4d4c-ae55-21790ae019a4";
const projectB = "b1c7e513-b094-4d4c-ae55-21790ae019a4";

let serial = 0;
function mapping(pathPrefix: string, projectId: string, kind: "path_prefix" | "url_rule" = "path_prefix"): PathMappingCandidate {
  serial += 1;
  return { id: `m${serial}`, kind, pathPrefix, projectId };
}

describe("repoLabel", () => {
  it("names the last segment of a path, whatever separators it uses", () => {
    expect(repoLabel("C:\\dev\\clock-in")).toBe("clock-in");
    expect(repoLabel("C:/dev/clock-in/")).toBe("clock-in");
    expect(repoLabel("/home/alex/src/Pocket-Piggies")).toBe("Pocket-Piggies");
  });

  it("keeps the label's own case, unlike the matching path normalizer", () => {
    expect(repoLabel("C:\\Dev\\Clock-In")).toBe("Clock-In");
  });

  it("returns null when there is no segment left to name", () => {
    expect(repoLabel("/")).toBeNull();
    expect(repoLabel("")).toBeNull();
  });

  // The roster filled with rows called "Claude Code @ 01M06FSGP392MH6VJNRX8T364A":
  // a no-mistakes gate checks the repo out at `<hash>.git/worktrees/<run ULID>`,
  // so the working directory's last segment was the run's id.
  it("refuses an opaque id as a codebase name", () => {
    expect(repoLabel("C:/Users/dev/.no-mistakes/repos/3946e592fa2c.git/worktrees/01M084ACAR719XGACT0GQT43HN")).toBeNull();
    expect(repoLabel("/tmp/01M06FSGP392MH6VJNRX8T364A")).toBeNull();
    expect(repoLabel("/runs/3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBeNull();
    expect(repoLabel(`/checkouts/${`a`.repeat(40)}`)).toBeNull();
    expect(repoLabel(`/checkouts/${`a`.repeat(64)}`)).toBeNull();
  });

  // Refusing ids must not start refusing codebases. These are real repo names
  // that a careless rule would swallow: hex-looking but shorter than a full
  // SHA-1 or SHA-256, digits with a separator, and a 26-character name that is
  // not base32.
  it("keeps names that only resemble one", () => {
    expect(repoLabel("/src/deadbeef")).toBe("deadbeef");
    expect(repoLabel("/src/deadbeefcafe")).toBe("deadbeefcafe");
    expect(repoLabel("/src/deadbeefcafedeadbeef")).toBe("deadbeefcafedeadbeef");
    expect(repoLabel("/src/2024-migrations")).toBe("2024-migrations");
    expect(repoLabel("/src/clock-in-desktop-ui")).toBe("clock-in-desktop-ui");
    expect(repoLabel("/src/v2")).toBe("v2");
  });

  // A run-together lowercase name lands on 26 characters easily, and Crockford
  // excludes only i, l, o and u - so a case-insensitive ULID rule read this
  // codebase as a run and folded its agent into the unassigned bucket.
  it("keeps a 26-character lowercase name, which no ULID is", () => {
    expect(repoLabel("/src/backendservermanagementapp")).toBe("backendservermanagementapp");
    expect(identityRepoRoot("/src/backendservermanagementapp")).toBe("/src/backendservermanagementapp");
    // The uppercase ids that started this are still refused.
    expect(repoLabel("/tmp/01M084ACAR719XGACT0GQT43HN")).toBeNull();
    expect(repoLabel("/tmp/01M06FSGP392MH6VJNRX8T364A")).toBeNull();
  });

  describe("identityRepoRoot", () => {
    it("keeps a root that names a codebase", () => {
      expect(identityRepoRoot("C:/dev/clock-in")).toBe("C:/dev/clock-in");
      expect(identityRepoRoot(null)).toBeNull();
    });

    // Keying identity on a per-run worktree minted one agent per run, which is
    // what buried the roster. Such a shift belongs in the unassigned bucket.
    it("drops a root that names only a run", () => {
      expect(identityRepoRoot("/repos/3946e592fa2c.git/worktrees/01M084ACAR719XGACT0GQT43HN")).toBeNull();
    });
  });

  it("caps a pathological segment at the contract's length", () => {
    expect(repoLabel(`/src/${"n".repeat(500)}`)).toHaveLength(200);
  });
});

// The treehouse worktree slug is the shape that made a directory nobody named
// look like ten codebases: `<slug>-<6hex>`. It is the narrowest of the four
// opaque shapes on purpose, because it is the only one a real repository could
// wear, so the suffix has to carry a digit.
describe("repoLabel and the worktree slug", () => {
  it("refuses a slug carrying a random hex suffix", () => {
    expect(repoLabel("C:/w/ai-automation-agency-redesign-c65da8")).toBeNull();
    expect(repoLabel("C:/w/dazzling-lamarr-0aacbd")).toBeNull();
    expect(repoLabel("C:/w/goofy-haslett-4b3191")).toBeNull();
    expect(repoLabel("C:/w/rebase-merge-open-prs-fe9680")).toBeNull();
    expect(repoLabel("C:/w/billing-legacy-50-accounting-4578f4")).toBeNull();
    expect(repoLabel("C:/w/simon-cre-wrap-command-cf9c1e")).toBeNull();
    expect(repoLabel("C:/w/upwork-workflow-improvements-560a70")).toBeNull();
  });

  // Six letters that happen to spell hex are ordinary English, and folding a
  // real repository into the unassigned bucket loses its attribution, which is
  // worse than letting the odd all-letter suffix through - identity comes from
  // the remote, and only the label ever reads this.
  it("keeps a name whose tail is hex-shaped but carries no digit", () => {
    expect(repoLabel("/src/wine-facade")).toBe("wine-facade");
    expect(repoLabel("/src/my-app-decade")).toBe("my-app-decade");
    expect(repoLabel("/src/project-deadbeef")).toBe("project-deadbeef");
  });

  it("keeps a short numeric suffix, which no worktree wears", () => {
    expect(repoLabel("/src/log4j-2")).toBe("log4j-2");
    expect(repoLabel("/src/base-64")).toBe("base-64");
    expect(repoLabel("/src/es2015")).toBe("es2015");
  });

  // The mirror of the digit rule, and the more expensive half: a dated or
  // numbered directory is a name someone chose, and for a local-only
  // repository swallowing it costs the identity rather than the label -
  // `identityRepoKey` reaches lane 2 through `repoLabel`, so the whole
  // repository would pool into its operator's unassigned bucket.
  it("keeps a dated or numbered directory, whose suffix carries no hex letter", () => {
    expect(repoLabel("C:/dev/invoices-202601")).toBe("invoices-202601");
    expect(repoLabel("C:/archive/release-20240115")).toBe("release-20240115");
    expect(repoLabel("C:/dev/sprint-123456")).toBe("sprint-123456");
    expect(identityRepoKey("C:/dev/invoices-202601", null)).toBe("path:C:/dev/invoices-202601");
  });
});

describe("normalizeRemote", () => {
  // One repository, six spellings, one identity. This is the whole fix: the
  // remote is the only identifier that is the same in every worktree, in a
  // second checkout under a different directory name, and on another machine.
  it("reduces every spelling of one remote to the same value", () => {
    const expected = "github.com/fpresta0607/precisiondocs";
    expect(normalizeRemote("git@github.com:fpresta0607/precisiondocs.git")).toBe(expected);
    expect(normalizeRemote("https://github.com/fpresta0607/precisiondocs.git")).toBe(expected);
    expect(normalizeRemote("https://github.com/fpresta0607/precisiondocs")).toBe(expected);
    expect(normalizeRemote("ssh://git@github.com/fpresta0607/precisiondocs.git")).toBe(expected);
    expect(normalizeRemote("git://github.com/fpresta0607/precisiondocs.git")).toBe(expected);
    expect(normalizeRemote("https://GitHub.COM/FPresta0607/PrecisionDocs.GIT")).toBe(expected);
    expect(normalizeRemote("  https://github.com/fpresta0607/precisiondocs/  ")).toBe(expected);
  });

  it("drops credentials and transport, which name no repository", () => {
    // Assembled rather than written out: a literal `user:pass@host` URL reads
    // as a Basic Auth credential to a secret scanner even when it holds none.
    const userinfo = "alex:secret";
    expect(normalizeRemote(`https://${userinfo}@github.com/acme/api.git`)).toBe("github.com/acme/api");
    expect(normalizeRemote("ssh://git@github.com:2222/acme/api.git")).toBe("github.com/acme/api");
    expect(normalizeRemote("https://github.com:443/acme/api")).toBe("github.com/acme/api");
  });

  it("keeps a self-hosted host and its full path", () => {
    expect(normalizeRemote("git@gitlab.example.test:team/group/service.git")).toBe("gitlab.example.test/team/group/service");
  });

  // The form `git clone` accepts with an absolute path after the colon, which
  // self-hosted setups use. Refusing it dropped that repository into the path
  // lane, where it goes on splitting per worktree - the defect itself.
  it("accepts an scp-style remote whose path is absolute", () => {
    expect(normalizeRemote("git@git.example.com:/srv/git/api.git")).toBe("git.example.com/srv/git/api");
    expect(normalizeRemote("git.example.com:/srv/git/api")).toBe("git.example.com/srv/git/api");
  });

  // A directory is a checkout, not a repository: two clones from one local bare
  // repo are still two checkouts, so these fall through to the path lane rather
  // than pretending to be a shared identity.
  it("refuses a remote that names a directory rather than a host", () => {
    expect(normalizeRemote("C:/dev/mirror.git")).toBeNull();
    expect(normalizeRemote("C:\\dev\\mirror.git")).toBeNull();
    expect(normalizeRemote("/srv/git/mirror.git")).toBeNull();
    expect(normalizeRemote("../sibling")).toBeNull();
    expect(normalizeRemote("file:///srv/git/mirror.git")).toBeNull();
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("   ")).toBeNull();
    expect(normalizeRemote("https://github.com")).toBeNull();
    expect(normalizeRemote("https://github.com/")).toBeNull();
  });
});

describe("identityRepoKey", () => {
  // The defect, stated as a test: two worktrees, two paths, one repository.
  it("gives two worktrees of one remote the same key", () => {
    const remote = "git@github.com:fpresta0607/precisiondocs.git";
    const first = identityRepoKey("C:/Users/fpres/.treehouse/precisiondocs-fdd5f2/1/precisiondocs", remote);
    const second = identityRepoKey("C:/Users/fpres/.treehouse/precisiondocs-fdd5f2/2/precisiondocs", remote);
    expect(first).toBe("github.com/fpresta0607/precisiondocs");
    expect(second).toBe(first);
  });

  // Two checkouts of one GitHub repository under different directory names -
  // `C:/dev/PrecisionDocs-AI` and `C:/dev/code-goblins/projects/precisiondocs`.
  // No basename comparison could ever collapse these; only the remote can.
  it("gives two checkouts under different names the same key", () => {
    const ai = identityRepoKey("C:/dev/PrecisionDocs-AI", "https://github.com/fpresta0607/precisiondocs.git");
    const goblins = identityRepoKey("C:/dev/code-goblins/projects/precisiondocs", "git@github.com:fpresta0607/precisiondocs.git");
    expect(ai).toBe(goblins);
  });

  // A worktree names no codebase, but the repository it holds is still known.
  it("keys a run-named worktree on its remote rather than on nothing", () => {
    expect(identityRepoKey("C:/w/dazzling-lamarr-0aacbd", "git@github.com:acme/api.git")).toBe("github.com/acme/api");
  });

  // A local-only repository is legitimate and must not collapse into one
  // bucket with every other one, so its own directory identifies it - verbatim,
  // because 0016's backfill and this lane have to compose the same string.
  it("falls back to the repo root when there is no remote", () => {
    expect(identityRepoKey("C:/dev/scratchpad", null)).toBe("path:C:/dev/scratchpad");
    expect(identityRepoKey("C:/dev/scratchpad", "/srv/git/mirror.git")).toBe("path:C:/dev/scratchpad");
  });

  // Outside any repository at all: the honest unassigned case, one bucket per
  // operator rather than a row per run.
  it("keys nothing when neither a remote nor a codebase name is left", () => {
    expect(identityRepoKey(null, null)).toBeNull();
    expect(identityRepoKey("C:/w/dazzling-lamarr-0aacbd", null)).toBeNull();
    expect(identityRepoKey("C:/Users/fpres/AppData/Local/Temp", null)).toBe("path:C:/Users/fpres/AppData/Local/Temp");
  });
});

describe("repoKeyLabel", () => {
  it("names the repository from a remote key and the directory from a path key", () => {
    expect(repoKeyLabel("github.com/fpresta0607/precisiondocs")).toBe("precisiondocs");
    expect(repoKeyLabel("path:C:/dev/Clock-In")).toBe("Clock-In");
  });

  it("has nothing to say about a path key that names only a run", () => {
    expect(repoKeyLabel("path:C:/w/dazzling-lamarr-0aacbd")).toBeNull();
  });
});

describe("agentCodebaseLabel", () => {
  // The regression the roster showed: one worktree of a repository minted the
  // row, so its folder name became the displayed codebase for every shift from
  // every worktree. The key is what the identity is, so the key names it.
  it("names the repository the identity is keyed on, not the worktree that minted the row", () => {
    expect(agentCodebaseLabel("C:/dev/clock-in-worktrees/fix-login", "github.com/acme/clock-in")).toBe("clock-in");
    expect(agentCodebaseLabel("C:/dev/PrecisionDocs-AI", "github.com/fpresta0607/precisiondocs-ai")).toBe("precisiondocs-ai");
  });

  it("reads a path key as its own directory, and falls back to the root only without a key", () => {
    expect(agentCodebaseLabel("C:/dev/Clock-In", "path:C:/dev/Clock-In")).toBe("Clock-In");
    expect(agentCodebaseLabel("C:/dev/Clock-In", null)).toBe("Clock-In");
  });

  it("has no name for the unassigned bucket, or for a key and a root that both name only a run", () => {
    expect(agentCodebaseLabel(null, null)).toBeNull();
    expect(agentCodebaseLabel("C:/w/dazzling-lamarr-0aacbd", "path:C:/w/dazzling-lamarr-0aacbd")).toBeNull();
  });
});

describe("normalizePath", () => {
  it("unifies case and separators and strips trailing separators", () => {
    expect(normalizePath("C:\\Dev\\Clock-In\\")).toBe("c:/dev/clock-in");
    expect(normalizePath("C:/Dev/Clock-In/")).toBe("c:/dev/clock-in");
    expect(normalizePath("C:\\dev\\clock-in/src")).toBe("c:/dev/clock-in/src");
    expect(normalizePath("c:/")).toBe("c:");
  });
});

describe("resolveProjectForCwd", () => {
  it("returns null with no mappings or no match", () => {
    expect(resolveProjectForCwd("C:/dev/clock-in", [])).toBeNull();
    expect(resolveProjectForCwd("C:/other/place", [mapping("C:/dev", projectA)])).toBeNull();
  });

  it("matches exactly, case-insensitively and across slash styles", () => {
    const mappings = [mapping("C:\\Dev\\Clock-In", projectA)];
    expect(resolveProjectForCwd("c:/dev/clock-in", mappings)).toBe(projectA);
    expect(resolveProjectForCwd("C:/DEV/CLOCK-IN/", mappings)).toBe(projectA);
  });

  it("matches subdirectories but only on path-segment boundaries", () => {
    const mappings = [mapping("C:/dev/clock", projectA)];
    expect(resolveProjectForCwd("c:/dev/clock/packages/shared", mappings)).toBe(projectA);
    expect(resolveProjectForCwd("C:/dev/clock-in-extra", mappings)).toBeNull();
    expect(resolveProjectForCwd("C:/dev/clocks", mappings)).toBeNull();
  });

  it("ignores a trailing separator on the stored prefix", () => {
    const mappings = [mapping("C:/dev/clock-in/", projectA)];
    expect(resolveProjectForCwd("c:/dev/clock-in", mappings)).toBe(projectA);
    expect(resolveProjectForCwd("c:/dev/clock-in/apps", mappings)).toBe(projectA);
  });

  it("picks the longest matching prefix", () => {
    const mappings = [
      mapping("C:/dev", projectA),
      mapping("C:/dev/clock-in", projectB),
    ];
    expect(resolveProjectForCwd("c:/dev/clock-in/apps/api", mappings)).toBe(projectB);
    expect(resolveProjectForCwd("c:/dev/other", mappings)).toBe(projectA);
  });

  it("rejects equal-length ties as ambiguous, unless they name the same project", () => {
    const ambiguous = [
      mapping("C:/dev/clock-in", projectA),
      mapping("c:\\dev\\clock-in\\", projectB),
    ];
    expect(resolveProjectForCwd("c:/dev/clock-in", ambiguous)).toBeNull();

    const agreeing = [
      mapping("C:/dev/clock-in", projectA),
      mapping("c:\\dev\\clock-in\\", projectA),
    ];
    expect(resolveProjectForCwd("c:/dev/clock-in", agreeing)).toBe(projectA);
  });

  it("prefers an unambiguous longer match over an ambiguous shorter one", () => {
    const mappings = [
      mapping("C:/dev", projectA),
      mapping("c:\\dev", projectB),
      mapping("C:/dev/clock-in", projectB),
    ];
    expect(resolveProjectForCwd("c:/dev/clock-in", mappings)).toBe(projectB);
  });

  it("ignores shorter matches that arrive after the longest one, in any input order", () => {
    const longestFirst = [
      mapping("C:/dev/clock-in", projectB),
      mapping("C:/dev", projectA),
    ];
    expect(resolveProjectForCwd("C:/dev/clock-in/apps", longestFirst)).toBe(projectB);
    expect(resolveProjectForCwd("C:/dev/clock-in/apps", [...longestFirst].reverse())).toBe(projectB);
  });

  it("never matches a url_rule pattern against a working directory", () => {
    const mappings = [mapping("C:/dev/clock-in", projectA, "url_rule")];
    expect(resolveProjectForCwd("c:/dev/clock-in", mappings)).toBeNull();
  });
});

describe("resolveProjectForRule", () => {
  it("resolves a browser span's rule id to its url_rule mapping's project", () => {
    const rule = mapping("github.com/acme/*", projectA, "url_rule");
    expect(resolveProjectForRule(rule.id, [rule])).toBe(projectA);
  });

  it("returns null for an unknown or deleted rule id", () => {
    const rule = mapping("github.com/acme/*", projectA, "url_rule");
    expect(resolveProjectForRule("missing-rule-id", [rule])).toBeNull();
  });

  it("never resolves a path_prefix mapping id, even when the id matches", () => {
    const prefix = mapping("C:/dev", projectA);
    expect(resolveProjectForRule(prefix.id, [prefix])).toBeNull();
  });
});
