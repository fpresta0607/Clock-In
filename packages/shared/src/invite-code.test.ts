import { describe, expect, it } from "vitest";

import {
  generateInviteCode,
  inviteCodeLength,
  inviteCodePattern,
  normalizeInviteCode,
} from "./invite-code.js";

const bytesFrom = (values: number[]) => (size: number) =>
  Uint8Array.from({ length: size }, (_, index) => values[index % values.length] as number);

describe("invite codes", () => {
  it("formats a generated code as two typed groups", () => {
    const code = generateInviteCode(bytesFrom([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

    expect(code).toMatch(inviteCodePattern);
    expect(code).toHaveLength(inviteCodeLength + 1);
    expect(code[5]).toBe("-");
  });

  it("never emits characters that are misread when typed", () => {
    const code = generateInviteCode(bytesFrom([...Array(256).keys()]));

    expect(code.replace("-", "")).not.toMatch(/[01258BILOSZ]/);
  });

  it("accepts what a person actually types", () => {
    const code = generateInviteCode(bytesFrom([11, 3, 20, 7, 15, 2, 9, 18, 4, 22]));
    const compact = code.replace("-", "");

    expect(normalizeInviteCode(code)).toBe(code);
    expect(normalizeInviteCode(compact)).toBe(code);
    expect(normalizeInviteCode(compact.toLowerCase())).toBe(code);
    expect(normalizeInviteCode(`  ${code.toLowerCase()}  `)).toBe(code);
  });

  it("rejects anything that could not be a code", () => {
    expect(normalizeInviteCode("")).toBeNull();
    expect(normalizeInviteCode("TOO-SHORT")).toBeNull();
    expect(normalizeInviteCode("AAAAA-AAAAA-AAAAA")).toBeNull();
    // Contains 0, which is not in the alphabet.
    expect(normalizeInviteCode("AAAAA-AAAA0")).toBeNull();
  });

  it("spreads across the alphabet rather than repeating one character", () => {
    const code = generateInviteCode((size) => Uint8Array.from({ length: size }, (_, index) => index * 7));

    expect(new Set(code.replace("-", "")).size).toBeGreaterThan(5);
  });
});
