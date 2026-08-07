import { describe, expect, it } from "vitest";

import { formatDuration } from "./time.js";

describe("formatDuration", () => {
  it("formats zero elapsed seconds", () => {
    expect(formatDuration(0)).toBe("00:00:00");
  });

  it("formats the minute boundary", () => {
    expect(formatDuration(60)).toBe("00:01:00");
  });

  it("formats the hour boundary", () => {
    expect(formatDuration(3_600)).toBe("01:00:00");
  });
});
