import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { buildFileTree, ProjectFileTree } from "../src/components/ProjectFileTree";

const files = { project: "demo", dirs: ["empty"], files: [
  { path: "main.py", size: 10 }, { path: "pkg/util.py", size: 20 },
  { path: "pkg/nested/helper.py", size: 30 }, { path: "__init__.py", size: 1 },
] };
function mount() {
  const onFile = vi.fn();
  const onDeleteFolder = vi.fn();
  const props = { projects: [{ name: "demo" }], project: "demo", files, busy: () => false,
    onCreate: vi.fn(), onProject: vi.fn(), onFile, onRename: vi.fn(), onDelete: vi.fn(), onDeleteFolder };
  const view = render(<ProjectFileTree {...props} />);
  return { ...view, props, onFile, onDeleteFolder };
}

it("builds intermediate and empty directories, orders directories first, and counts descendants", () => {
  const tree = buildFileTree(files.files, files.dirs);
  expect(tree.map((node) => node.name)).toEqual(["empty", "pkg", "__init__.py", "main.py"]);
  expect(tree[0].children).toEqual([]);
  expect(tree[1].count).toBe(2);
  expect(tree[1].children.map((node) => node.name)).toEqual(["nested", "util.py"]);
  expect(tree[1].children[0].children[0].file?.path).toBe("pkg/nested/helper.py");
});

it("folds branches without opening files and reveals a file selected by search", async () => {
  const { rerender, props, onFile } = mount();
  fireEvent.click(screen.getByRole("button", { name: "pkg/" }));
  expect(screen.queryByRole("treeitem", { name: "pkg/util.py" })).toBeNull();
  expect(onFile).not.toHaveBeenCalled();
  rerender(<ProjectFileTree {...props} selectedFile="pkg/nested/helper.py" />);
  const leaf = await screen.findByRole("treeitem", { name: "pkg/nested/helper.py" });
  expect(leaf.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /^pkg\/nested\/helper\.py / }));
  expect(onFile).toHaveBeenCalledWith("pkg/nested/helper.py");
  fireEvent.click(screen.getByRole("button", { name: "demo" }));
  expect(screen.queryByRole("treeitem", { name: "main.py" })).toBeNull();
});

it("navigates the visible hierarchy with arrows and keeps directory actions working", async () => {
  const { onDeleteFolder } = mount();
  const directory = screen.getByRole("treeitem", { name: "pkg/" });
  directory.focus();
  fireEvent.keyDown(directory, { key: "ArrowLeft" });
  expect(directory.getAttribute("aria-expanded")).toBe("false");
  fireEvent.keyDown(directory, { key: "ArrowRight" });
  fireEvent.keyDown(directory, { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "pkg/nested/" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(directory);
  fireEvent.contextMenu(directory);
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  expect(onDeleteFolder).toHaveBeenCalledWith("pkg");
  await waitFor(() => expect(screen.getByRole("treeitem", { name: "pkg/" }).tabIndex).toBe(0));
});

it("opens the context menu with Shift+F10 and creates inside the chosen directory", () => {
  const { props } = mount();
  const directory = screen.getByRole("treeitem", { name: "pkg/" });
  directory.focus();
  fireEvent.keyDown(directory, { key: "F10", shiftKey: true });
  const menu = screen.getByRole("menu", { name: "文件操作" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "新建文件" }));
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "新建目录" }));
  fireEvent.click(document.activeElement!);
  expect(props.onCreate).toHaveBeenCalledWith("directory", "pkg");
  expect(screen.queryByRole("menu")).toBeNull();
});
