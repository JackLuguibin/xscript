import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UiPreview } from "../src/components/UiPreview";

const spec = JSON.stringify({ version: 1, title: "挂机设置", submit: "开始", width: "85vw", height: "60vh",
  fields: [{ kind: "text", id: "account", label: "账号" }, { kind: "number", id: "rounds", label: "轮数", default: 3 }] });

describe("UiPreview (desktop UI designer D.2)", () => {
  it("renders the generated page into a fully sandboxed iframe, never into the page DOM", () => {
    render(<UiPreview text={spec} />);
    const frame = screen.getByTitle("界面预览") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    const doc = frame.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("挂机设置");
    expect(doc).toContain("账号");
    // nothing of the form leaks into the host page
    expect(screen.queryByText("账号")).toBeNull();
  });

  it("lists spec problems and reports JSON that does not parse", () => {
    const bad = JSON.stringify({ fields: [{ kind: "text", id: "class", label: "x" }, { kind: "select", id: "a", label: "y" }] });
    const { unmount } = render(<UiPreview text={bad} />);
    const problems = screen.getByRole("list", { name: "界面文件的问题" });
    expect(problems.textContent).toContain("id must be a Python identifier");
    expect(problems.textContent).toContain("needs at least one option");
    unmount();
    render(<UiPreview text="{ not json" />);
    expect(screen.getByRole("alert").textContent).toMatch(/^无法解析这个界面文件：/);
    expect(screen.queryByTitle("界面预览")).toBeNull();
  });
});
