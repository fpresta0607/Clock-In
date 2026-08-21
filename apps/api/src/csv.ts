import type { ReportResponse, ReportRow } from "@siqshift/shared";

const header = [
  "sessionId", "userId", "userName", "projectId", "projectName", "description",
  "status", "startedAt", "stoppedAt", "idleSeconds", "durationSeconds",
  "attribution", "attributedSeconds", "unattributedSeconds",
] as const;

function safeCell(value: string | number): string {
  const text = String(value);
  return /^\s*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function csvCell(value: string | number): string {
  const text = safeCell(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

export function reportCsvHeader(): string {
  return `${header.join(",")}\r\n`;
}

export function reportCsvRow(row: ReportRow): string {
  return [
    row.id, row.user.id, row.user.name, row.project.id, row.project.name, row.description ?? "", row.status,
    row.startedAt, row.stoppedAt, row.idleSeconds, row.durationSeconds,
    row.attribution, row.attributedSeconds, row.unattributedSeconds,
  ].map(csvCell).join(",") + "\r\n";
}

export function reportCsvTotal(totalDurationSeconds: number): string {
  return ["TOTAL", "", "", "", "", "", "", "", "", "", totalDurationSeconds, "", "", ""].map(csvCell).join(",") + "\r\n";
}

export function reportToCsv(report: ReportResponse): string {
  return reportCsvHeader() + report.rows.map(reportCsvRow).join("") + reportCsvTotal(report.totalDurationSeconds);
}
