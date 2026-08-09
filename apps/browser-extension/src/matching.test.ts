import { describe, expect, it } from "vitest";

import { match, parsePattern, type UrlRule } from "./matching.js";

const rules: UrlRule[] = [
  { id: "github-org", pattern: "github.com/acme/*" },
  { id: "github-site", pattern: "github.com" },
  { id: "figma-files", pattern: "*.figma.com/files/*" },
  { id: "linear", pattern: "app.linear.app/acme/*" },
];

describe("parsePattern", () => {
  it("rejects patterns outside the grammar", () => {
    expect(parsePattern("")).toBeNull();
    expect(parsePattern("   ")).toBeNull();
    expect(parsePattern("https://github.com")).toBeNull();
    expect(parsePattern("git*hub.com")).toBeNull();
    expect(parsePattern("github.com/*/acme")).toBeNull();
    expect(parsePattern("github.com/a*c")).toBeNull();
    expect(parsePattern("github.com/a/*/b")).toBeNull();
    expect(parsePattern("*.")).toBeNull();
    expect(parsePattern("x".repeat(501))).toBeNull();
  });

  it("parses host-only, exact-path, glob-path, and wildcard-host patterns", () => {
    expect(parsePattern("github.com")).toEqual({
      host: "github.com",
      anySubdomain: false,
      path: null,
      pathIsGlob: false,
    });
    expect(parsePattern("github.com/acme")).toEqual({
      host: "github.com",
      anySubdomain: false,
      path: "acme",
      pathIsGlob: false,
    });
    expect(parsePattern("github.com/acme/*")).toEqual({
      host: "github.com",
      anySubdomain: false,
      path: "acme",
      pathIsGlob: true,
    });
    expect(parsePattern("*.figma.com/files/*")).toEqual({
      host: "figma.com",
      anySubdomain: true,
      path: "files",
      pathIsGlob: true,
    });
  });

  it("parses an empty glob stem (host/*) as any-path", () => {
    expect(parsePattern("github.com/*")).toEqual({
      host: "github.com",
      anySubdomain: false,
      path: null,
      pathIsGlob: false,
    });
  });
});

describe("match", () => {
  it("matches host-only rules on any path", () => {
    expect(match("https://github.com/", rules)).toBe("github-site");
    expect(match("https://github.com/notifications", rules)).toBe("github-site");
  });

  it("matches an empty glob stem (host/*) on any path, including deep ones", () => {
    const star: UrlRule[] = [{ id: "star", pattern: "github.com/*" }];
    expect(match("https://github.com/", star)).toBe("star");
    expect(match("https://github.com/acme", star)).toBe("star");
    expect(match("https://github.com/acme/repo/pull/1", star)).toBe("star");
    expect(match("https://other.com/acme", star)).toBeNull();
  });

  it("matches hosts case-insensitively", () => {
    expect(match("https://GITHUB.COM/", rules)).toBe("github-site");
    expect(match("https://GitHub.com/acme/", rules)).toBe("github-org");
  });

  it("treats a trailing glob as a boundary-aware prefix", () => {
    expect(match("https://github.com/acme", rules)).toBe("github-org");
    expect(match("https://github.com/acme/", rules)).toBe("github-org");
    expect(match("https://github.com/acme/repo/pull/1", rules)).toBe("github-org");
    expect(match("https://github.com/acmeville", rules)).toBe("github-site");
  });

  it("matches exact paths without a glob exactly", () => {
    const exact: UrlRule[] = [{ id: "exact", pattern: "example.com/pricing" }];
    expect(match("https://example.com/pricing", exact)).toBe("exact");
    expect(match("https://example.com/pricing/team", exact)).toBeNull();
  });

  it("matches wildcard hosts on the bare domain and any subdomain", () => {
    expect(match("https://www.figma.com/files/abc", rules)).toBe("figma-files");
    expect(match("https://figma.com/files/abc", rules)).toBe("figma-files");
    expect(match("https://evilfigma.com/files/abc", rules)).toBeNull();
    expect(match("https://figma.com.evil.example/files/abc", rules)).toBeNull();
    expect(match("https://www.figma.com/community", rules)).toBeNull();
  });

  it("prefers the longest matching pattern", () => {
    expect(match("https://github.com/acme/repo", rules)).toBe("github-org");
    const ordered: UrlRule[] = [
      { id: "short", pattern: "example.com" },
      { id: "long", pattern: "example.com/app/*" },
    ];
    expect(match("https://example.com/app/x", ordered)).toBe("long");
    expect(match("https://example.com/app/x", [...ordered].reverse())).toBe("long");
  });

  it("breaks length ties toward the earlier rule", () => {
    const tied: UrlRule[] = [
      { id: "first", pattern: "a.example.com/x" },
      { id: "second", pattern: "a.example.com/y" },
    ];
    expect(match("https://a.example.com/x", tied)).toBe("first");
    expect(match("https://a.example.com/x", [...tied].reverse())).toBe("first");
  });

  it("is case-sensitive on paths", () => {
    expect(match("https://github.com/ACME/repo", rules)).toBe("github-site");
  });

  it("ignores query strings and fragments when matching the path", () => {
    expect(match("https://github.com/acme/repo?tab=issues#top", rules)).toBe("github-org");
  });

  it("returns null for unmatched, invalid, or non-http URLs", () => {
    expect(match("https://unlisted.example.com/", rules)).toBeNull();
    expect(match("not a url", rules)).toBeNull();
    expect(match("chrome://extensions", rules)).toBeNull();
    expect(match("about:blank", rules)).toBeNull();
    expect(match("file:///etc/passwd", rules)).toBeNull();
  });

  it("fails closed: broken rules and an empty rule set match nothing", () => {
    expect(match("https://github.com/acme/repo", [])).toBeNull();
    const broken: UrlRule[] = [
      { id: "bad-scheme", pattern: "https://github.com" },
      { id: "bad-glob", pattern: "github.com/*/acme" },
    ];
    expect(match("https://github.com/acme/repo", broken)).toBeNull();
  });
});
