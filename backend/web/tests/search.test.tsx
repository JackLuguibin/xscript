import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SearchInput } from "../src/components";

describe("SearchInput", () => {
  it("debounces typing by 300 ms, trims, and does not fire on mount", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput placeholder="搜索设备" onSearch={onSearch} initial="x" />);
    act(() => vi.advanceTimersByTime(1000));
    expect(onSearch).not.toHaveBeenCalled(); // the initial value is not a new search

    const input = screen.getByLabelText("搜索设备");
    fireEvent.change(input, { target: { value: "  pix" } });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.change(input, { target: { value: "  pixel " } });
    act(() => vi.advanceTimersByTime(299));
    expect(onSearch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("pixel");
  });

  it("uses the latest onSearch without restarting the timer", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<SearchInput placeholder="q" onSearch={first} />);
    fireEvent.change(screen.getByLabelText("q"), { target: { value: "a" } });
    act(() => vi.advanceTimersByTime(150));
    rerender(<SearchInput placeholder="q" onSearch={second} />);
    act(() => vi.advanceTimersByTime(150));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("a");
  });
});
