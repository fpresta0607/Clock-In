/// Display names for the agent CLI families the hook contract knows about.
/// Shared by the timer screen and the "what's recorded" panel so one tool is
/// never called two different things.
const AGENT_SOURCE_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  kimi_code: "Kimi Code",
  cursor: "Cursor",
};

export const sourceLabel = (source: string): string => AGENT_SOURCE_LABELS[source] ?? source;
