import type { ReactElement } from "react";

import { findAgentRuntime } from "@clock-in/shared";

/**
 * Runtime marks for the "what's switched on" list.
 *
 * A mark only ships here when the official asset can be sourced cleanly, which
 * means a real asset published by the project under a licence that lets
 * Clock-In redistribute it. Today that is opencode alone: its mark ships in
 * `sst/opencode` under the MIT licence the rest of that repository carries, and
 * showing it to name opencode is what the mark is for.
 *
 * No such asset could be found for Claude Code, Codex, Cursor, Kimi Code, Pi,
 * pi-signed, Grok, Muse, or GitHub Copilot — their installed packages ship no
 * logo, and their marks are not published as reusable assets. Those runtimes
 * therefore get the generic badge below. Clock-In does not draw a lookalike
 * from memory: a wrong mark misrepresents somebody else's product, and a plain
 * monogram is honest about what Clock-In actually has.
 *
 * The roster's `icon` field is what selects a mark, so a runtime gains one by
 * gaining an asset here and a name there.
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

const MARKS: Record<string, () => ReactElement> = {
  opencode: OpencodeMark,
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
