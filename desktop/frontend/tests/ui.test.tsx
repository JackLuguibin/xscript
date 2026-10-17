import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert } from "../src/components/ui/alert";
import { Badge } from "../src/components/ui/badge";
import { Button } from "../src/components/ui/button";
import { Dialog } from "../src/components/ui/dialog";
import { Input } from "../src/components/ui/input";
import { Select } from "../src/components/ui/select";

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
    expect(screen.getByRole("button", { name: "Default" }).className).toContain("bg-surface");
    expect(screen.getByRole("button", { name: "Save" }).className).toContain("bg-primary");
    expect(screen.getByRole("button", { name: "Ghost" }).className).toContain("bg-transparent");
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
});
