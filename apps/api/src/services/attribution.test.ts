import { describe, expect, it } from "vitest";

import { normalizePath, resolveProjectForCwd } from "./attribution.js";

const projectA = "a1c7e513-b094-4d4c-ae55-21790ae019a4";
const projectB = "b1c7e513-b094-4d4c-ae55-21790ae019a4";

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
    expect(resolveProjectForCwd("C:/other/place", [{ pathPrefix: "C:/dev", projectId: projectA }])).toBeNull();
  });

  it("matches exactly, case-insensitively and across slash styles", () => {
    const mappings = [{ pathPrefix: "C:\\Dev\\Clock-In", projectId: projectA }];
    expect(resolveProjectForCwd("c:/dev/clock-in", mappings)).toBe(projectA);
    expect(resolveProjectForCwd("C:/DEV/CLOCK-IN/", mappings)).toBe(projectA);
  });

  it("matches subdirectories but only on path-segment boundaries", () => {
    const mappings = [{ pathPrefix: "C:/dev/clock", projectId: projectA }];
    expect(resolveProjectForCwd("c:/dev/clock/packages/shared", mappings)).toBe(projectA);
    expect(resolveProjectForCwd("C:/dev/clock-in-extra", mappings)).toBeNull();
    expect(resolveProjectForCwd("C:/dev/clocks", mappings)).toBeNull();
  });

  it("ignores a trailing separator on the stored prefix", () => {
    const mappings = [{ pathPrefix: "C:/dev/clock-in/", projectId: projectA }];
    expect(resolveProjectForCwd("c:/dev/clock-in", mappings)).toBe(projectA);
    expect(resolveProjectForCwd("c:/dev/clock-in/apps", mappings)).toBe(projectA);
  });

  it("picks the longest matching prefix", () => {
    const mappings = [
      { pathPrefix: "C:/dev", projectId: projectA },
      { pathPrefix: "C:/dev/clock-in", projectId: projectB },
    ];
    expect(resolveProjectForCwd("c:/dev/clock-in/apps/api", mappings)).toBe(projectB);
    expect(resolveProjectForCwd("c:/dev/other", mappings)).toBe(projectA);
  });

  it("rejects equal-length ties as ambiguous, unless they name the same project", () => {
    const ambiguous = [
      { pathPrefix: "C:/dev/clock-in", projectId: projectA },
      { pathPrefix: "c:\\dev\\clock-in\\", projectId: projectB },
    ];
    expect(resolveProjectForCwd("c:/dev/clock-in", ambiguous)).toBeNull();

    const agreeing = [
      { pathPrefix: "C:/dev/clock-in", projectId: projectA },
      { pathPrefix: "c:\\dev\\clock-in\\", projectId: projectA },
    ];
    expect(resolveProjectForCwd("c:/dev/clock-in", agreeing)).toBe(projectA);
  });

  it("prefers an unambiguous longer match over an ambiguous shorter one", () => {
    const mappings = [
      { pathPrefix: "C:/dev", projectId: projectA },
      { pathPrefix: "c:\\dev", projectId: projectB },
      { pathPrefix: "C:/dev/clock-in", projectId: projectB },
    ];
    expect(resolveProjectForCwd("c:/dev/clock-in", mappings)).toBe(projectB);
  });
});
