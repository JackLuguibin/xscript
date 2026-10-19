import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert } from "../src/components/ui/alert";
import { Badge } from "../src/components/ui/badge";
import { Button } from "../src/components/ui/button";
import { Dialog } from "../src/components/ui/dialog";
import { Input } from "../src/components/ui/input";
import { Select } from "../src/components/ui/select";
import { Textarea } from "../src/components/ui/textarea";
import { cn } from "../src/lib/cn";

describe("ui primitives", () => {
  it("renders every button variant, the small size, and an asChild link", () => {
    render(
      <>
        <Button>Default</Button>
        <Button variant="primary" size="sm">Save</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger" disabled>Danger</Button>
        <Button variant="nav">Nav</Button>
        <Button asChild><a href="#next">Link</a></Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Default" }).className).toBe("ui-btn ui-btn-default");
    expect(screen.getByRole("button", { name: "Save" }).className).toBe("ui-btn ui-btn-primary ui-btn-sm");
    expect(screen.getByRole("button", { name: "Ghost" }).className).toBe("ui-btn ui-btn-ghost");
    expect(screen.getByRole("button", { name: "Danger" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Nav" }).className).toContain("nav-item");
    expect(screen.getByRole("link", { name: "Link" }).getAttribute("href")).toBe("#next");
  });

  it("renders a text field, both alert tones, and the neutral badge", () => {
    render(
      <>
        <Input aria-label="name" placeholder="p" />
        <Select aria-label="kind" defaultValue="a"><option value="a">甲</option></Select>
        <Alert tone="warn">careful</Alert>
        <Alert tone="error" role="alert">bad</Alert>
        <Badge>idle</Badge>
      </>,
    );
    expect(screen.getByRole("textbox", { name: "name" }).getAttribute("placeholder")).toBe("p");
    expect((screen.getByRole("combobox", { name: "kind" }) as HTMLSelectElement).value).toBe("a");
    expect(screen.getByText("careful").className).toContain("warn");
    expect(screen.getByRole("alert").className).toContain("error");
    expect(screen.getByText("idle").className).toContain("bg-neutral-bg");
  });

  it("closes the dialog from the backdrop and keeps a press inside", () => {
    const restoreFocus = { current: true };
    let closed = 0;
    render(
      <Dialog title="标题" closeLabel="关闭" onClose={() => { closed += 1; }} restoreFocus={restoreFocus}>
        <p>body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "标题" });
    fireEvent.mouseDown(dialog);
    expect(closed).toBe(0);
    fireEvent.mouseDown(document.querySelector(".overlay-backdrop")!);
    expect(closed).toBe(1);
  });

  it("names the toolbar variants and the icon size, and lets a className utility ride along", () => {
    render(
      <>
        <Button variant="toolbar">Tool</Button>
        <Button variant="toolbarPrimary">Add</Button>
        <Button variant="toolbarDanger">Delete</Button>
        <Button variant="toolbar" size="icon" aria-label="Library" aria-pressed="true" className="flow-bar-icon" />
        <Button variant="bare" className="w-full">Bare</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Tool" }).className).toBe("ui-btn ui-btn-toolbar");
    expect(screen.getByRole("button", { name: "Add" }).className).toBe("ui-btn ui-btn-toolbar-primary");
    expect(screen.getByRole("button", { name: "Delete" }).className).toBe("ui-btn ui-btn-toolbar-danger");
    expect(screen.getByRole("button", { name: "Library" }).className).toBe("ui-btn ui-btn-toolbar ui-btn-icon flow-bar-icon");
    expect(screen.getByRole("button", { name: "Bare" }).className).toBe("ui-btn w-full");
  });

  it("gives each field primitive its ui.css class and keeps the caller's classes", () => {
    render(
      <>
        <Input aria-label="in" className="grow w-auto" />
        <Textarea aria-label="area" className="code-snip" />
        <Select aria-label="pick" className="w-auto min-w-40"><option>x</option></Select>
      </>,
    );
    expect(screen.getByRole("textbox", { name: "in" }).className).toBe("ui-input grow w-auto");
    expect(screen.getByRole("textbox", { name: "area" }).className).toBe("ui-textarea code-snip");
    expect(screen.getByRole("combobox", { name: "pick" }).className).toBe("ui-select w-auto min-w-40");
  });

  it("merges utilities on our own theme scales, so the later class wins", () => {
    expect(cn("px-sp-3", "px-0")).toBe("px-0");
    expect(cn("py-sp-1 gap-sp-2", "py-0 gap-0")).toBe("py-0 gap-0");
    expect(cn("rounded-sm", "rounded-pill")).toBe("rounded-pill");
    expect(cn("text-sm", "text-md")).toBe("text-md");
    expect(cn("shadow-card", "shadow-none")).toBe("shadow-none");
    // Size and colour are different groups, so both stay.
    expect(cn("text-md", "text-fg")).toBe("text-md text-fg");
  });
});
