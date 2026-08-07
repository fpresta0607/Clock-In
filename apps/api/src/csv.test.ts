import { describe, expect, it } from "vitest";

import { reportToCsv } from "./csv.js";

describe("report CSV", () => {
  it("uses a fixed header, CRLF lines, RFC4180 escaping, and a clear total row", () => {
    expect(reportToCsv({
      filters: {},
      totalDurationSeconds: 60,
      rows: [{
        id: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
        user: { id: "e1c7e513-b094-4d4c-ae55-21790ae019a4", name: " Alex, \"Formula\"" },
        project: { id: "a1c7e513-b094-4d4c-ae55-21790ae019a4", name: "Build" },
        description: "=SUM(A1:A2)\r\nnext",
        status: "stopped",
        startedAt: "2026-08-06T14:00:00.000Z",
        stoppedAt: "2026-08-06T14:01:00.000Z",
        idleSeconds: 0,
        durationSeconds: 60,
      }],
    })).toBe(
      "sessionId,userId,userName,projectId,projectName,description,status,startedAt,stoppedAt,idleSeconds,durationSeconds\r\n"
      + "c1c7e513-b094-4d4c-ae55-21790ae019a4,e1c7e513-b094-4d4c-ae55-21790ae019a4,\" Alex, \"\"Formula\"\"\",a1c7e513-b094-4d4c-ae55-21790ae019a4,Build,\"'=SUM(A1:A2)\r\nnext\",stopped,2026-08-06T14:00:00.000Z,2026-08-06T14:01:00.000Z,0,60\r\n"
      + "TOTAL,,,,,,,,,,60\r\n",
    );
  });

  it("neutralizes formulas after whitespace, including tabs and carriage returns", () => {
    expect(reportToCsv({ filters: {}, totalDurationSeconds: 0, rows: [{
      id: "c1c7e513-b094-4d4c-ae55-21790ae019a4", user: { id: "e1c7e513-b094-4d4c-ae55-21790ae019a4", name: "\t@bad" }, project: { id: "a1c7e513-b094-4d4c-ae55-21790ae019a4", name: "\r-safe" }, description: null, status: "needs_review", startedAt: "2026-08-06T14:00:00.000Z", stoppedAt: "2026-08-06T14:00:00.000Z", idleSeconds: 0, durationSeconds: 0,
    }] })).toContain("'\t@bad");
  });
});
