/** Display names for well-known executables, shared by every stats surface. */
const FRIENDLY_APP_NAMES: Record<string, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  firefox: "Firefox",
  brave: "Brave",
  arc: "Arc",
  code: "VS Code",
  cursor: "Cursor",
  windowsterminal: "Windows Terminal",
  pwsh: "PowerShell",
  powershell: "Windows PowerShell",
  cmd: "Command Prompt",
  explorer: "File Explorer",
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
  zoom: "Zoom",
  notion: "Notion",
  obsidian: "Obsidian",
  figma: "Figma",
  spotify: "Spotify",
  winword: "Microsoft Word",
  excel: "Microsoft Excel",
  taskmgr: "Task Manager",
};

/**
 * "chrome.exe" -> "Google Chrome"; unknown processes lose the extension and
 * get title-cased ("app-09.exe" -> "App 09").
 */
export function friendlyAppName(processName: string): string {
  const base = processName.replace(/\.exe$/i, "");
  const known = FRIENDLY_APP_NAMES[base.toLowerCase()];
  if (known !== undefined) return known;
  return base
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
