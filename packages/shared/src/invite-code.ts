/**
 * Invite codes get read off a screen and typed by hand, so the alphabet omits
 * every pair that looks alike in a sans-serif font: 0/O, 1/I/L, 2/Z, 5/S, 8/B.
 */
const alphabet = "ACDEFGHJKMNPQRTUVWXY34679";
const groupSize = 5;
const groups = 2;

export const inviteCodeLength = groupSize * groups;

/** Formats as AAAAA-AAAAA. Matching is case-insensitive and ignores the dash. */
export const inviteCodePattern = new RegExp(`^[${alphabet}]{${groupSize}}-[${alphabet}]{${groupSize}}$`);

export function generateInviteCode(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(inviteCodeLength);
  let code = "";
  for (let index = 0; index < inviteCodeLength; index += 1) {
    if (index > 0 && index % groupSize === 0) code += "-";
    // Modulo bias across a 25-letter alphabet is under 3%, which does not
    // meaningfully dent 25^10 (~9.5e13) of search space behind a rate limit.
    code += alphabet[(bytes[index] as number) % alphabet.length];
  }
  return code;
}

/**
 * Accepts what a person actually types: any case, with or without the dash,
 * and with stray whitespace. Returns null when it could not be a code at all.
 */
export function normalizeInviteCode(input: string): string | null {
  const compact = input.replace(/[\s-]/g, "").toUpperCase();
  if (compact.length !== inviteCodeLength) return null;
  const formatted = `${compact.slice(0, groupSize)}-${compact.slice(groupSize)}`;
  return inviteCodePattern.test(formatted) ? formatted : null;
}
