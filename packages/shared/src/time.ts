export function formatDuration(elapsedSeconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedSeconds));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

/**
 * Human-readable durations for every stats surface: "2h 14m", "14m", "32s".
 * One helper on purpose - the desktop, the web, and the API's consumers must
 * all spell a duration the same way.
 */
export function formatHumanDuration(elapsedSeconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedSeconds));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}
