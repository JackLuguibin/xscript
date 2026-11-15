import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TreeView } from "../src/components/ui/tree-view";

describe("shared tree control", () => {
  it("supports collapsing, expanding and keyboard movement through the hierarchy", async () => {
    const user = userEvent.setup();
    render(<TreeView label="Nodes" entries={[{ id: "root", label: "Root", value: 1, children: [{ id: "child", label: "Child", value: 2 }] }]}
      selected={null} onSelect={() => {}} previousLabel="Previous" nextLabel="Next" pageSummary={(p, n) => `${p}/${n}`} />);
    const root = screen.getByRole("treeitem", { name: "Root" });
    root.focus();
    await user.keyboard("{ArrowLeft}");
    expect(root.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "Child" })).toBeNull();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "Child" }));
    expect(screen.getByRole("treeitem", { name: "Child" }).getAttribute("aria-level")).toBe("2");
  });
});
