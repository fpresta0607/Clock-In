import { describe, expect, it } from "vitest";

import { MULTI_PROJECT_HOSTS, narrowedPattern, normalizeOrigin, planRule } from "./patterns.js";

describe("planRule", () => {
  it("plans a whole-site rule for an ordinary origin", () => {
    expect(planRule("quickbooks.com")).toEqual({
      kind: "whole-site",
      origin: "quickbooks.com",
      pattern: "*.quickbooks.com",
    });
  });

  it("covers the bare host and subdomains with a leading glob", () => {
    const plan = planRule("figma.com");
    expect(plan?.kind).toBe("whole-site");
    expect(plan).toMatchObject({ pattern: "*.figma.com" });
  });

  it("normalizes case, whitespace, and a trailing dot", () => {
    expect(planRule("  QuickBooks.COM. ")).toMatchObject({
      kind: "whole-site",
      origin: "quickbooks.com",
    });
  });

  it("plans the narrowed question for multi-project hosts", () => {
    for (const host of ["github.com", "gitlab.com", "bitbucket.org", "linear.app"]) {
      expect(planRule(host)).toEqual({ kind: "path-narrowed", origin: host });
    }
    expect(MULTI_PROJECT_HOSTS.size).toBe(4);
  });

  it("rejects origins that can never form a rule", () => {
    expect(planRule("")).toBeNull();
    expect(planRule("not a host")).toBeNull();
    expect(planRule("has/path.com")).toBeNull();
    expect(planRule("*.figma.com")).toMatchObject({ kind: "whole-site", origin: "figma.com" });
  });
});

describe("narrowedPattern", () => {
  it("builds the path-narrowed rule from one segment", () => {
    expect(narrowedPattern("github.com", "acme")).toBe("github.com/acme/*");
    expect(narrowedPattern("linear.app", "Acme-Team")).toBe("linear.app/acme-team/*");
  });

  it("refuses anything that is not a single clean segment", () => {
    expect(narrowedPattern("github.com", "")).toBeNull();
    expect(narrowedPattern("github.com", "acme corp")).toBeNull();
    expect(narrowedPattern("github.com", "acme/eng")).toBeNull();
    expect(narrowedPattern("github.com", "acme*")).toBeNull();
    expect(narrowedPattern("github.com", "-acme-")).toBeNull();
  });

  it("only narrows multi-project hosts", () => {
    expect(narrowedPattern("quickbooks.com", "acme")).toBeNull();
  });
});

describe("normalizeOrigin", () => {
  it("keeps multi-label and hyphenated hosts", () => {
    expect(normalizeOrigin("app.example.co.uk")).toBe("app.example.co.uk");
    expect(normalizeOrigin("my-host.com")).toBe("my-host.com");
  });
});
