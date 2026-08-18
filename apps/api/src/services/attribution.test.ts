import { describe, expect, it } from "vitest";

import { identityRepoRoot, normalizePath, repoLabel, resolveProjectForCwd, resolveProjectForRule, type PathMappingCandidate } from "./attribution.js";

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
