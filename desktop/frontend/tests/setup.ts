import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// findBy*/waitFor: the full parallel run (14+ jsdom files) can exceed the 1 s default on a busy machine
configure({ asyncUtilTimeout: 4000 });

afterEach(() => cleanup());
