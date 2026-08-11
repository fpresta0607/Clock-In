import { leaderboardFiltersSchema, reportFiltersSchema } from "@clock-in/shared";
import { describe, expect, it } from "vitest";

import { rangeQuery } from "./App.js";

/**
 * The dashboard and the API ship on separate manual deploys, so the only thing
 * holding them to the same request shape is this contract. `rangeQuery` is the
 * single place the dashboard composes a report range; `reportFiltersSchema` and
 * `leaderboardFiltersSchema` are what the API parses that range with, and both
 * are `.strict()`, so a parameter one side invents and the other has never heard
 * of is a flat `400` rather than a harmlessly ignored key.
 *
 * These read the query the dashboard actually emits instead of restating its
 * parameter names, which is what makes them fail if either side moves alone.
 * That is the skew that took Reports and the Leaderboard down in production:
 * the web bundle sent `fromAt`/`toExclusiveAt` to an API built before those
 * fields existed. Deploy order is what fixes a live skew, but this keeps the two
 * halves of the contract from parting company in the first place.
 */
const ranges = ["7", "30", "365"] as const;

/** Exactly what the dashboard's report call appends beside the range. */
const reportPageSize = "25";

const parametersOf = (query: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(query));

describe("web and API report contract", () => {
  it.each(ranges)("accepts the leaderboard query the dashboard sends for the %s-day range", (range) => {
    const parameters = parametersOf(rangeQuery(range));

    const filters = leaderboardFiltersSchema.parse(parameters);

    expect(filters.fromAt).toBe(parameters.fromAt);
    expect(filters.toExclusiveAt).toBe(parameters.toExclusiveAt);
  });

  it.each(ranges)("accepts the report query the dashboard sends for the %s-day range", (range) => {
    const parameters = parametersOf(`${rangeQuery(range)}&pageSize=${reportPageSize}`);

    const filters = reportFiltersSchema.parse(parameters);

    expect(filters.fromAt).toBe(parameters.fromAt);
    expect(filters.toExclusiveAt).toBe(parameters.toExclusiveAt);
    expect(filters.pageSize).toBe(Number(reportPageSize));
  });

  it("sends instant bounds rather than calendar dates, which the API refuses to mix", () => {
    const parameters = parametersOf(rangeQuery("30"));

    expect(Object.keys(parameters).sort()).toEqual(["fromAt", "toExclusiveAt"]);
    expect(() => leaderboardFiltersSchema.parse({ ...parameters, from: "2026-08-06" })).toThrow();
  });
});
