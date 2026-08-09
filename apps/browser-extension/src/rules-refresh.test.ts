//! The pure half of the rules-refresh path: the background re-evaluates the
//! active tab with `match` whenever a new rule set arrives and feeds the
//! verdict like a tab activation. These tests pin that behavior.

import { describe, expect, it } from "vitest";

import { match, type UrlRule } from "./matching.js";
import { advance, createSpanMachine, handleInput } from "./spans.js";

const T0 = Date.UTC(2026, 7, 9, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const URL_ON_TAB = "https://github.com/acme/repo";
const RULES: UrlRule[] = [{ id: "rule-a", pattern: "github.com/acme/*" }];

describe("rules refresh re-applied to the active tab", () => {
  it("a tab classified against empty rules starts dwelling once rules arrive", () => {
    const machine = createSpanMachine({ newSessionId: () => "span-1" });
    // Startup: the tab is open but the rule set has not arrived yet.
    handleInput(machine, { type: "active-tab", ruleId: match(URL_ON_TAB, []) }, T0);
    expect(advance(machine, T0 + 60_000)).toEqual([]);

    // The first get-rules reply lands; the background re-evaluates the tab.
    handleInput(machine, { type: "active-tab", ruleId: match(URL_ON_TAB, RULES) }, T0 + 60_000);
    expect(advance(machine, T0 + 74_000)).toEqual([]);
    expect(advance(machine, T0 + 75_000)).toEqual([
      {
        event: "started",
        externalSessionId: "span-1",
        ruleId: "rule-a",
        occurredAt: iso(T0 + 60_000),
      },
    ]);
  });

  it("a refreshed rule set that drops the rule ends the open span", () => {
    const machine = createSpanMachine({ newSessionId: () => "span-1" });
    handleInput(machine, { type: "active-tab", ruleId: match(URL_ON_TAB, RULES) }, T0);
    advance(machine, T0 + 15_000); // span opens

    // The five-minute refresh returns a set that no longer covers the tab.
    handleInput(machine, { type: "active-tab", ruleId: match(URL_ON_TAB, []) }, T0 + 20_000);
    expect(advance(machine, T0 + 34_000)).toEqual([]);
    expect(advance(machine, T0 + 35_000)).toEqual([
      {
        event: "ended",
        externalSessionId: "span-1",
        ruleId: "rule-a",
        occurredAt: iso(T0 + 20_000),
      },
    ]);
  });
});
