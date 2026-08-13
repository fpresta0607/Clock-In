import { describe, expect, it } from "vitest";

import { friendlyAppName } from "./app-names.js";
import { formatDuration, formatHumanDuration } from "./time.js";

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

describe("formatHumanDuration", () => {
  it("speaks each magnitude in its own unit", () => {
    expect(formatHumanDuration(32)).toBe("32 sec");
    expect(formatHumanDuration(14 * 60)).toBe("14 min");
    expect(formatHumanDuration(2 * 3_600 + 14 * 60)).toBe("2 hr 14 min");
    expect(formatHumanDuration(3 * 3_600)).toBe("3 hr");
  });

  it("treats negatives and fractions as floor-at-zero seconds", () => {
    expect(formatHumanDuration(-5)).toBe("0 sec");
    expect(formatHumanDuration(89.9)).toBe("1 min");
  });
});

describe("friendlyAppName", () => {
  it("names known executables and title-cases the rest", () => {
    expect(friendlyAppName("chrome.exe")).toBe("Google Chrome");
    expect(friendlyAppName("WINWORD.exe")).toBe("Microsoft Word");
    expect(friendlyAppName("app-09.exe")).toBe("App 09");
  });
});
