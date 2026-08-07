import type { ReportResponse } from "@clock-in/shared";

const header = [
  "sessionId", "userId", "userName", "projectId", "projectName", "description",
  "status", "startedAt", "stoppedAt", "idleSeconds", "durationSeconds",
] as const;

function safeCell(value: string | number): string {
  const text = String(value);
  return /^\s*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function csvCell(value: string | number): string {
  const text = safeCell(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

export function reportToCsv(report: ReportResponse): string {
  const rows = report.rows.map((row) => [
    row.id, row.user.id, row.user.name, row.project.id, row.project.name, row.description ?? "", row.status,
    row.startedAt, row.stoppedAt, row.idleSeconds, row.durationSeconds,
  ].map(csvCell).join(","));
  return [header.join(","), ...rows, ["TOTAL", "", "", "", "", "", "", "", "", "", report.totalDurationSeconds].map(csvCell).join(",")].join("\r\n") + "\r\n";
}
