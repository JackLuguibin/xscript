// Same rule as the desktop client (desktop/frontend/src/run-trace.ts).
/** Where a failed run stopped in the project's own code: the innermost frame of the last traceback in the run's log
 * whose file lies in the project folder on the phone (`.../projects/<project>/<path>`). Frames in the runtime or the
 * standard library are skipped. */
export interface FailedLine {
  path: string; // project-relative, e.g. "utils/net.py"
  line: number;
  message: string; // the exception line, e.g. "ZeroDivisionError: division by zero"
}

export function failedLine(log: string, project: string): FailedLine | null {
  const parts = log.split("Traceback (most recent call last):");
  if (parts.length < 2) return null;
  const block = parts[parts.length - 1] ?? "";
  const marker = `/projects/${project}/`;
  let hit: { path: string; line: number } | null = null;
  for (const m of block.matchAll(/File "([^"]+)", line (\d+)/g)) {
    const file = (m[1] ?? "").replace(/\\/g, "/");
    const at = file.lastIndexOf(marker);
    if (at < 0) continue;
    const path = file.slice(at + marker.length);
    if (path) hit = { path, line: Number(m[2]) };
  }
  if (!hit) return null;
  let message = "";
  for (const raw of block.split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith(" ") || raw.startsWith("\t")) continue;
    message = raw.trim();
  }
  return { ...hit, message };
}
