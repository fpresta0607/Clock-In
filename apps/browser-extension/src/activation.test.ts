import { describe, expect, it } from "vitest";

import { shouldApplyTabActivation } from "./activation.js";

describe("shouldApplyTabActivation", () => {
  it("accepts activations in the OS-focused window", () => {
    expect(shouldApplyTabActivation(7, 7)).toBe(true);
  });

  it("ignores activations in a background window", () => {
    expect(shouldApplyTabActivation(8, 7)).toBe(false);
  });

  it("ignores every activation while no window holds OS focus", () => {
    expect(shouldApplyTabActivation(7, null)).toBe(false);
  });
});
