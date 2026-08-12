import type { ReactElement } from "react";

import { findAgentRuntime } from "@clock-in/shared";

/**
 * Runtime marks for the "what's switched on" list and the live session stats.
 *
 * Two kinds of mark ship here, and the difference matters legally.
 *
 * An **official asset** ships only when the project publishes one under a
 * licence that lets Clock-In redistribute it. Today that is opencode alone: its
 * mark ships in `sst/opencode` under the MIT licence the rest of that
 * repository carries.
 *
 * Every other runtime gets a **Clock-In mark**: an original monochrome glyph
 * drawn for this app, from one coherent set, in `currentColor` on a 24×24 grid.
 * These are deliberately *not* imitations of anybody's logo. Anthropic, OpenAI,
 * Cursor, Moonshot, xAI, and GitHub all publish brand assets under terms that
 * do not permit redistribution in a third-party app, and drawing a lookalike
 * from memory would misrepresent somebody else's product while infringing the
 * same trademark. An original glyph naming a runtime inside Clock-In's own UI
 * is honest about whose drawing it is and needs no licence from anyone.
 *
 * The roster's `icon` field selects the mark, so a runtime gains one by naming
 * it there and adding it below.
 */

/**
 * opencode's official mark. Source: `sst/opencode`,
 * `packages/console/app/src/asset/brand/opencode-logo-dark-square.svg` (MIT).
 * Reproduced verbatim apart from the ids, which are namespaced so two copies on
 * one page cannot collide.
 */
const OpencodeMark = () => (
  <svg viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g transform="translate(30, 0)">
      <g clipPath="url(#clock-in-opencode-clip)">
        <mask
          id="clock-in-opencode-mask"
          style={{ maskType: "luminance" }}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="240"
          height="300"
        >
          <path d="M240 0H0V300H240V0Z" fill="white" />
        </mask>
        <g mask="url(#clock-in-opencode-mask)">
          <path d="M180 240H60V120H180V240Z" fill="#4B4646" />
          <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#F1ECEC" />
        </g>
      </g>
    </g>
    <defs>
      <clipPath id="clock-in-opencode-clip">
        <rect width="240" height="300" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

/**
 * The Clock-In mark set: one original monochrome glyph per runtime, all on the
 * same 24×24 grid with the same 2px stroke, so a list of them reads as one
 * family rather than as scavenged logos. Each is a distinct silhouette, which
 * is what makes a row identifiable at a glance.
 */
const ClockInMark = ({ children }: { children: ReactElement | ReactElement[] }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/// Claude's own burst: rays radiating from a centre, the shape the tool is
/// known by. A command prompt sat here before, which read as "a terminal"
/// rather than as this particular tool.
const ClaudeCodeMark = () => (
  <ClockInMark>
    <path d="M12 3.2v6" />
    <path d="M12 14.8v6" />
    <path d="M3.2 12h6" />
    <path d="M14.8 12h6" />
    <path d="m5.8 5.8 4.2 4.2" />
    <path d="m14 14 4.2 4.2" />
    <path d="m18.2 5.8-4.2 4.2" />
    <path d="m10 14-4.2 4.2" />
  </ClockInMark>
);

/// Nested brackets: code inside code.
const CodexMark = () => (
  <ClockInMark>
    <path d="M9 5 4 12l5 7" />
    <path d="M15 5l5 7-5 7" />
    <path d="M12.5 8.5 11.5 15.5" />
  </ClockInMark>
);

/// A pointer, for the editor that follows one.
const CursorMark = () => (
  <ClockInMark>
    <path d="M5 3.5 18.5 11 12 12.5 9.5 19z" />
  </ClockInMark>
);

/// A crescent, for Kimi.
const KimiMark = () => (
  <ClockInMark>
    <path d="M18 15.5A7.5 7.5 0 0 1 8.5 6a7.5 7.5 0 1 0 9.5 9.5z" />
  </ClockInMark>
);

/// The letter the runtime is named after, drawn rather than set in type so it
/// keeps the same weight as the rest of the set.
const PiMark = () => (
  <ClockInMark>
    <path d="M4 7h16" />
    <path d="M9 7v10" />
    <path d="M16 7v8a2 2 0 0 0 2 2" />
  </ClockInMark>
);

/// Pi, with the seal that tells the signed build apart.
const PiSignedMark = () => (
  <ClockInMark>
    <path d="M3 6h12" />
    <path d="M7 6v11" />
    <path d="M12.5 6v7" />
    <path d="M15 17.5l2.5 2.5 4.5-5.5" />
  </ClockInMark>
);

/// A spark.
const GrokMark = () => (
  <ClockInMark>
    <path d="M12 2v6" />
    <path d="M12 16v6" />
    <path d="M4.2 6.2 8.5 10.5" />
    <path d="M15.5 13.5l4.3 4.3" />
    <path d="M2 12h6" />
    <path d="M16 12h6" />
  </ClockInMark>
);

/// A quill nib.
const MuseMark = () => (
  <ClockInMark>
    <path d="M4 20c6-2 9-5 11-9l2.5-6.5L11 7C7 9 5 13 4 20z" />
    <path d="M4 20 11 13" />
  </ClockInMark>
);

/// Two marks in step: the second seat.
const CopilotMark = () => (
  <ClockInMark>
    <circle cx="9" cy="12" r="5.5" />
    <path d="M15 6.8a5.5 5.5 0 0 1 0 10.4" />
  </ClockInMark>
);

const MARKS: Record<string, () => ReactElement> = {
  opencode: OpencodeMark,
  claude_code: ClaudeCodeMark,
  codex: CodexMark,
  cursor: CursorMark,
  kimi_code: KimiMark,
  pi: PiMark,
  pi_signed: PiSignedMark,
  grok: GrokMark,
  muse: MuseMark,
  copilot: CopilotMark,
};

/**
 * The badge beside a runtime's name: its official mark when Clock-In has one,
 * and the first letter of its label when it does not. An undeclared runtime
 * falls through to the same monogram, so a CLI nobody has named yet still reads
 * as an agent rather than as nothing.
 */
export const AgentRuntimeIcon = ({ source }: { source: string }) => {
  const runtime = findAgentRuntime(source);
  const icon = runtime?.icon ?? null;
  const Mark = icon === null ? undefined : MARKS[icon];
  if (Mark !== undefined) {
    return (
      <span className="agent-mark" data-testid={`agent-mark-${source}`}>
        <Mark />
      </span>
    );
  }
  const initial = (runtime?.label ?? source).trim().charAt(0).toUpperCase();
  return (
    <span className="agent-mark is-generic" aria-hidden="true" data-testid={`agent-mark-${source}`}>
      {initial}
    </span>
  );
};
