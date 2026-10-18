import { afterEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// findBy*/waitFor: antd renders slowly in jsdom on a busy machine
configure({ asyncUtilTimeout: 4000 });

// antd's responsive helpers call matchMedia, which jsdom does not implement.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// antd's tables, tabs and overflow lists observe their size.
if (typeof window.ResizeObserver === "undefined") {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom logs "Not implemented" for getComputedStyle(el, "::before") (antd measures scrollbars that way).
const computed = window.getComputedStyle.bind(window);
window.getComputedStyle = (el: Element) => computed(el);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
