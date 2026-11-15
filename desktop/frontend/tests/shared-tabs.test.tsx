import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tabs } from "../src/components/ui/tabs";

function Example() {
  const [value, setValue] = useState("first");
  return <Tabs label="Sections" value={value} onValueChange={setValue} items={[
    { value: "first", label: "First" },
    { value: "disabled", label: "Unavailable", disabled: true },
    { value: "last", label: "Last" },
  ]}><button>Content {value}</button></Tabs>;
}

describe("shared tabs navigation", () => {
  it("skips disabled tabs, wraps, and supports Home and End", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "First" }));
    await user.keyboard("{ArrowRight}");
    const last = screen.getByRole("tab", { name: "Last" });
    expect(document.activeElement).toBe(last);
    expect(last.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Last" }).id).toBe(last.getAttribute("aria-controls"));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "First" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(last);
    await user.keyboard("{Home}{ArrowLeft}");
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tabpanel"));
  });
});
