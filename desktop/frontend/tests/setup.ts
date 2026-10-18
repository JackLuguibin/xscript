import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", { configurable: true, writable: true, value: ResizeObserverStub });

class DOMMatrixReadOnlyStub {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  m11 = 1; m12 = 0; m13 = 0; m14 = 0;
  m21 = 0; m22 = 1; m23 = 0; m24 = 0;
  m31 = 0; m32 = 0; m33 = 1; m34 = 0;
  m41 = 0; m42 = 0; m43 = 0; m44 = 1;
  is2D = true;
  isIdentity = true;
  inverse() { return new DOMMatrixReadOnlyStub(); }
  multiply() { return new DOMMatrixReadOnlyStub(); }
  transformPoint<T>(point: T) { return point; }
}
Object.defineProperty(window, "DOMMatrixReadOnly", { configurable: true, writable: true, value: DOMMatrixReadOnlyStub });
Object.defineProperty(window, "DOMMatrix", { configurable: true, writable: true, value: DOMMatrixReadOnlyStub });

// findBy*/waitFor: the full parallel run (14+ jsdom files) can exceed the 1 s default on a busy machine
configure({ asyncUtilTimeout: 4000 });

afterEach(() => {
  cleanup();
  localStorage.clear(); // the current device (xscript.device) and other picks must not leak between tests
});
