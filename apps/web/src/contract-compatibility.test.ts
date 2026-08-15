import { agentPaystubFiltersSchema, agentsReportFiltersSchema, leaderboardFiltersSchema, meStatsFiltersSchema } from "@clock-in/shared";
import { describe, expect, it } from "vitest";

import { rangeQuery } from "./App.js";

/**
 * The dashboard and the API ship on separate manual deploys, so the only thing
 * holding them to the same request shape is this contract. `rangeQuery` is the
 * single place the dashboard composes a range; `leaderboardFiltersSchema` and
 * `meStatsFiltersSchema` are what the API parses that range with, and both are
 * `.strict()`, so a parameter one side invents and the other has never heard
 * of is a flat `400` rather than a harmlessly ignored key.
 *
 * These read the query the dashboard actually emits instead of restating its
 * parameter names, which is what makes them fail if either side moves alone.
 * That is the skew that took Reports and the Leaderboard down in production:
 * the web bundle sent `fromAt`/`toExclusiveAt` to an API built before those
 * fields existed. Deploy order is what fixes a live skew, but this keeps the two
 * halves of the contract from parting company in the first place.
 */
const boundedRanges = ["today", "7d", "30d", "90d"] as const;

/** A member id shaped like the ones the leaderboard hands the drill-down. */
const memberId = "b1c7e513-b094-4d4c-ae55-21790ae019a4";

const parametersOf = (query: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(query.replace(/^\?/, "")));

describe("web and API report contract", () => {
  it.each(boundedRanges)("accepts the leaderboard query the dashboard sends for %s", (range) => {
    const parameters = parametersOf(rangeQuery(range));

    const filters = leaderboardFiltersSchema.parse(parameters);

    expect(filters.fromAt).toBe(parameters.fromAt);
    expect(filters.toExclusiveAt).toBe(parameters.toExclusiveAt);
  });

  it("sends no bounds at all for all time, which both schemas accept", () => {
    expect(rangeQuery("all")).toBe("");
    expect(() => leaderboardFiltersSchema.parse({})).not.toThrow();
    expect(() => meStatsFiltersSchema.parse({ userId: memberId })).not.toThrow();
  });

  it.each(boundedRanges)("accepts the member-stats query the drill-down sends for %s", (range) => {
    const parameters = parametersOf(`${rangeQuery(range)}&userId=${memberId}`);

    const filters = meStatsFiltersSchema.parse(parameters);

    expect(filters.fromAt).toBe(parameters.fromAt);
    expect(filters.toExclusiveAt).toBe(parameters.toExclusiveAt);
    expect(filters.userId).toBe(memberId);
  });

  it.each(boundedRanges)("accepts the paystub query the roster tab sends for %s", (range) => {
    const parameters = parametersOf(rangeQuery(range));

    const filters = agentPaystubFiltersSchema.parse(parameters);

    expect(filters.fromAt).toBe(parameters.fromAt);
    expect(filters.toExclusiveAt).toBe(parameters.toExclusiveAt);
  });

  it("sends no paystub bounds at all for all time", () => {
    expect(rangeQuery("all")).toBe("");
    expect(() => agentPaystubFiltersSchema.parse({})).not.toThrow();
  });

  it.each(boundedRanges)("accepts the pay-run report query the roster tab sends for %s", (range) => {
    const parameters = parametersOf(rangeQuery(range));

    const filters = agentsReportFiltersSchema.parse(parameters);

    expect(filters.fromAt).toBe(parameters.fromAt);
    expect(filters.toExclusiveAt).toBe(parameters.toExclusiveAt);
  });

  it("sends no pay-run report bounds at all for all time, and carries a project scope", () => {
    expect(rangeQuery("all")).toBe("");
    expect(() => agentsReportFiltersSchema.parse({})).not.toThrow();
    const parameters = parametersOf(`${rangeQuery("today")}&scope=${memberId}`);
    expect(() => agentsReportFiltersSchema.parse(parameters)).not.toThrow();
  });

  it("sends instant bounds rather than calendar dates, which the API refuses to mix", () => {
    const parameters = parametersOf(rangeQuery("today"));

    expect(Object.keys(parameters).sort()).toEqual(["fromAt", "toExclusiveAt"]);
    expect(() => leaderboardFiltersSchema.parse({ ...parameters, from: "2026-08-06" })).toThrow();
  });
});
