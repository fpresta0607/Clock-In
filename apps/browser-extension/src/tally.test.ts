import { describe, expect, it } from "vitest";

import {
  addFocusSeconds,
  clearTally,
  emptyTally,
  originFor,
  registrableDomain,
  tallySnapshot,
} from "./tally.js";

describe("registrableDomain", () => {
  it("reduces subdomains to the eTLD+1", () => {
    expect(registrableDomain("github.com")).toBe("github.com");
    expect(registrableDomain("gist.github.com")).toBe("github.com");
    expect(registrableDomain("a.b.c.github.com")).toBe("github.com");
  });

  it("keeps one label above known compound suffixes", () => {
    expect(registrableDomain("foo.bar.co.uk")).toBe("bar.co.uk");
    expect(registrableDomain("bar.co.uk")).toBe("bar.co.uk");
    expect(registrableDomain("x.y.com.au")).toBe("y.com.au");
  });

  it("is case-insensitive and ignores a trailing dot", () => {
    expect(registrableDomain("WWW.GitHub.COM.")).toBe("github.com");
  });

  it("leaves dot-less hosts and IP literals alone", () => {
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("intranet")).toBe("intranet");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("originFor", () => {
  it("extracts the tally origin from http(s) URLs", () => {
    expect(originFor("https://app.quickbooks.com/v3/invoice")).toBe("quickbooks.com");
    expect(originFor("http://localhost:3000/dev")).toBe("localhost");
  });

  it("returns null for non-http or invalid URLs", () => {
    expect(originFor("chrome://newtab")).toBeNull();
    expect(originFor("about:blank")).toBeNull();
    expect(originFor("not a url")).toBeNull();
  });
});

describe("tally accumulation", () => {
  it("accumulates focus seconds per origin, folding subdomains together", () => {
    const tally = emptyTally();
    addFocusSeconds(tally, "quickbooks.com", 30);
    addFocusSeconds(tally, "quickbooks.com", 45);
    addFocusSeconds(tally, "figma.com", 10);
    expect(tally.entries).toEqual({ "quickbooks.com": 75, "figma.com": 10 });
  });

  it("ignores non-positive contributions", () => {
    const tally = emptyTally();
    addFocusSeconds(tally, "quickbooks.com", 0);
    addFocusSeconds(tally, "quickbooks.com", -5);
    expect(tally.entries).toEqual({});
  });

  it("snapshots in the host's wire shape, longest first", () => {
    const tally = emptyTally();
    addFocusSeconds(tally, "figma.com", 10);
    addFocusSeconds(tally, "quickbooks.com", 75);
    expect(tallySnapshot(tally)).toEqual([
      { origin: "quickbooks.com", seconds: 75 },
      { origin: "figma.com", seconds: 10 },
    ]);
  });

  it("clears on demand", () => {
    const tally = emptyTally();
    addFocusSeconds(tally, "quickbooks.com", 75);
    clearTally(tally);
    expect(tally.entries).toEqual({});
    expect(tallySnapshot(tally)).toEqual([]);
  });
});
