import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider, focusManager, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "../src/api";
import { createQueryClient } from "../src/queryClient";

function wrapper(client = createQueryClient()) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

afterEach(() => {
  setVisibility("visible");
  focusManager.setFocused(undefined);
});

describe("query defaults", () => {
  it("does not retry 4xx answers, retries 5xx and network errors twice", async () => {
    const retry = createQueryClient().getDefaultOptions().queries!.retry as (n: number, e: unknown) => boolean;
    expect(retry(0, new ApiError(403, "权限不足"))).toBe(false);
    expect(retry(0, new ApiError(401, "未登录"))).toBe(false);
    expect(retry(0, new ApiError(503, "x"))).toBe(true);
    expect(retry(1, new TypeError("Failed to fetch"))).toBe(true);
    expect(retry(2, new ApiError(500, "x"))).toBe(false);
  });

  // The pages poll with refetchInterval (Overview, Devices, Tasks, Pack, ...). Those polls stop in a
  // hidden tab and resume when it is shown again; hand-written loops need their own guard.
  it("refetchInterval polls pause while the tab is hidden", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => Date.now());
    renderHook(() => useQuery({ queryKey: ["poll"], queryFn: fn, refetchInterval: 1000 }), { wrapper: wrapper() });
    await act(() => vi.advanceTimersByTimeAsync(3100));
    const visibleCalls = fn.mock.calls.length;
    expect(visibleCalls).toBeGreaterThanOrEqual(3);

    setVisibility("hidden");
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(fn.mock.calls.length).toBe(visibleCalls);

    setVisibility("visible"); // refetchOnWindowFocus + the interval resumes
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(fn.mock.calls.length).toBeGreaterThan(visibleCalls);
  });
});
