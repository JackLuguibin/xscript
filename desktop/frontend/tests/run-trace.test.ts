import { describe, expect, it } from "vitest";
import { failedLine } from "../src/run-trace";

const P = "/storage/emulated/0/Android/data/com.xscript.app/files/projects";
const tb = (frames: string[], msg: string) =>
  ["Traceback (most recent call last):", ...frames.map((f) => `  File "${f}"\n    code()`), msg].join("\n");

describe("failedLine", () => {
  it("picks the innermost frame inside the project and the exception line", () => {
    const log = tb([`${P}/每日签到/__init__.py", line 4, in <module>`, `${P}/每日签到/utils/net.py", line 12, in get`, `/data/x/chaquopy/lib/json/__init__.py", line 3, in loads`], "ValueError: bad");
    expect(failedLine(log, "每日签到")).toEqual({ path: "utils/net.py", line: 12, message: "ValueError: bad" });
  });

  it("uses the last traceback when the log has several", () => {
    const first = tb([`${P}/demo/a.py", line 1, in <module>`], "KeyError: 'x'");
    const second = tb([`${P}/demo/b.py", line 7, in <module>`], "ZeroDivisionError: division by zero");
    expect(failedLine(`${first}\nretrying\n${second}`, "demo")).toEqual({ path: "b.py", line: 7, message: "ZeroDivisionError: division by zero" });
  });

  it("ignores frames of other projects and returns null without a traceback", () => {
    expect(failedLine(tb([`${P}/other/a.py", line 1, in <module>`], "E: x"), "demo")).toBeNull();
    expect(failedLine("all good\n", "demo")).toBeNull();
  });
});
