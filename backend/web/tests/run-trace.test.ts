import { describe, expect, it } from "vitest";
import { failedLine } from "../src/pages/devices/runTrace";

const P = "/storage/emulated/0/Android/data/com.xscript.app/files/projects";

describe("failedLine (admin 最近运行)", () => {
  it("innermost project frame of the last traceback, with the exception line", () => {
    const log = [
      "Traceback (most recent call last):",
      `  File "${P}/签到/__init__.py", line 2, in <module>`,
      `  File "${P}/签到/lib/tasks.py", line 3, in run`,
      `  File "/data/chaquopy/lib/json/__init__.py", line 9, in loads`,
      "ValueError: bad",
    ].join("\n");
    expect(failedLine(log, "签到")).toEqual({ path: "lib/tasks.py", line: 3, message: "ValueError: bad" });
    expect(failedLine(log, "其他")).toBeNull();
    expect(failedLine("ok", "签到")).toBeNull();
  });
});
