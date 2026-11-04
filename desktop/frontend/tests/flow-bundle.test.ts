import { describe, expect, it } from "vitest";
import { BUNDLE_EXT, BUNDLE_FORMAT, BUNDLE_MAX_BYTES, BUNDLE_VERSION, bundleFileName, bundleText, fnv1a32, packBundle, readBundle, type FlowBundle } from "../src/flow/bundle";
import { deployPlan, entryStub, pushPlan, type DeployApi } from "../src/flow/deploy";
import { parse, printFlow } from "../src/flow/dsl";
import { layoutFromGraph } from "../src/flow/layout";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { builtinSpecs } from "../src/flow/specs";

const specs = builtinSpecs();
const META = { createdAt: "2026-10-21T22:00:00-04:00", app: "0.5.0" };

function samplePlan(withLayout = true) {
  const graph = parse(SAMPLE_FLOW);
  const plan = deployPlan(graph, specs, withLayout ? layoutFromGraph(graph) : null);
  if (!plan.ok) throw new Error("sample flow should compile");
  return { graph, plan };
}

/** A packed sample bundle as plain JSON, for tampering with. */
function sampleRaw(): FlowBundle {
  return JSON.parse(bundleText(packBundle(samplePlan().plan, META))) as FlowBundle;
}

function reread(bundle: unknown) {
  return readBundle(JSON.stringify(bundle));
}

/** Replace one file's content and fix its size and checksum, so only the content check under test can fail. */
function withFile(bundle: FlowBundle, path: string, content: string): FlowBundle {
  return { ...bundle, files: bundle.files.map((file) => (file.path === path ? { ...file, content, size: new TextEncoder().encode(content).length, fnv1a: fnv1a32(content) } : file)) };
}

describe("fnv1a32", () => {
  it("matches the published FNV-1a 32-bit test vectors and hashes UTF-8 bytes", () => {
    expect(fnv1a32("")).toBe("811c9dc5");
    expect(fnv1a32("a")).toBe("e40c292c");
    expect(fnv1a32("foobar")).toBe("bf9cf968");
    expect(fnv1a32("签到")).not.toBe(fnv1a32("签"));
    expect(fnv1a32("签到")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("flow bundle", () => {
  it("packs the deploy plan with sizes and checksums, and reads back the same plan, graph, layout and map", () => {
    const { graph, plan } = samplePlan();
    const bundle = packBundle(plan, META);
    expect(bundle.format).toBe(BUNDLE_FORMAT);
    expect(bundle.version).toBe(BUNDLE_VERSION);
    expect(bundle.project).toBe("daily_signin");
    expect(bundle.app).toBe("0.5.0");
    expect(bundle.files.map((file) => file.path)).toEqual(plan.files.map((file) => file.path));
    for (const file of bundle.files) {
      expect(file.size).toBe(new TextEncoder().encode(file.content).length);
      expect(file.fnv1a).toBe(fnv1a32(file.content));
    }
    const text = bundleText(bundle);
    expect(text.endsWith("\n")).toBe(true);
    const read = readBundle(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.bundle).toEqual(bundle);
    expect(read.plan.project).toBe("daily_signin");
    expect(read.plan.files).toEqual(plan.files);
    expect(read.plan.map).toEqual(plan.map);
    expect(printFlow(read.graph)).toBe(printFlow(graph));
    expect(read.layout).toEqual(layoutFromGraph(graph));
  });

  it("works without a layout and without an app version", () => {
    const bundle = packBundle(samplePlan(false).plan, { createdAt: META.createdAt });
    expect("app" in bundle).toBe(false);
    const read = readBundle(bundleText(bundle));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.layout).toBeNull();
    expect(read.bundle.app).toBeUndefined();
  });

  it("names the file after the project", () => {
    expect(bundleFileName("daily_signin")).toBe("daily_signin" + BUNDLE_EXT);
  });

  it("pushes a read bundle to another device exactly like the editor's own plan", async () => {
    const read = readBundle(bundleText(packBundle(samplePlan().plan, META)));
    if (!read.ok) throw new Error(read.reason);
    const written: string[] = [];
    const api: DeployApi = {
      projects: async () => ({ projects: [] }),
      createProject: async () => ({ ok: true }),
      files: async () => ({ files: [] }),
      readFile: async () => ({ content: "" }),
      writeFile: async (_id, _project, path) => {
        written.push(path);
        return { ok: true };
      },
    };
    expect(await pushPlan(api, "lan:10.0.0.9:9860", read.plan)).toEqual({ ok: true, created: true });
    expect(written[0]).toBe("__init__.py");
    expect([...written].sort()).toEqual(read.plan.files.map((file) => file.path).sort());
  });

  it.each([
    ["not json", "{", "json"],
    ["wrong format", JSON.stringify({ format: "zip" }), "format"],
    ["not an object", "[]", "format"],
  ])("rejects %s", (_label, text, reason) => {
    const read = readBundle(text);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe(reason);
  });

  it("rejects a newer bundle version, a bad project name and bad metadata", () => {
    const raw = sampleRaw();
    const cases: Array<[unknown, string, string?]> = [
      [{ ...raw, version: 2 }, "version", "2"],
      [{ ...raw, project: "../evil" }, "name"],
      [{ ...raw, project: "9lives" }, "name"],
      [{ ...raw, createdAt: 5 }, "format", "createdAt"],
      [{ ...raw, app: 1 }, "format", "app"],
      [{ ...raw, files: "nope" }, "files"],
      [{ ...raw, files: [{ path: "__init__.py" }] }, "files"],
      [{ ...raw, files: [null] }, "files"],
    ];
    for (const [bundle, reason, detail] of cases) {
      const read = reread(bundle);
      expect(read.ok, reason).toBe(false);
      if (read.ok) continue;
      expect(read.reason).toBe(reason);
      if (detail) expect(read.detail).toBe(detail);
    }
  });

  it("only accepts the paths a flow project has, once each", () => {
    const raw = sampleRaw();
    const first = raw.files[0];
    for (const path of ["../__init__.py", "/etc/passwd", "flows\\x.py", "flows/other.py", "lib/tasks.py", "flows/./daily_signin.py"]) {
      const read = reread({ ...raw, files: [...raw.files, { ...first, path }] });
      expect(read.ok, path).toBe(false);
      if (!read.ok) expect([read.reason, read.detail]).toEqual(["path", path]);
    }
    const dup = reread({ ...raw, files: [...raw.files, first] });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect([dup.reason, dup.detail]).toEqual(["duplicate", first.path]);
  });

  it("catches truncated or edited files through the size and checksum", () => {
    const raw = sampleRaw();
    const build = "flows/daily_signin.py";
    const edited = { ...raw, files: raw.files.map((file) => (file.path === build ? { ...file, content: file.content + "\nimport os\n" } : file)) };
    const read = reread(edited);
    expect(read.ok).toBe(false);
    if (!read.ok) expect([read.reason, read.detail]).toEqual(["checksum", build]);
    const sized = { ...raw, files: raw.files.map((file) => (file.path === build ? { ...file, size: file.size + 1 } : file)) };
    const read2 = reread(sized);
    expect(read2.ok).toBe(false);
    if (!read2.ok) expect(read2.reason).toBe("checksum");
  });

  it("refuses a bundle bigger than the limit", () => {
    const raw = withFile(sampleRaw(), "flows/daily_signin.py", "#".repeat(BUNDLE_MAX_BYTES + 1));
    const read = reread(raw);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("size");
  });

  it("needs every required file", () => {
    const raw = sampleRaw();
    for (const path of ["flows/__init__.py", "flows/daily_signin.py", "flows/daily_signin.xflow", "flows/daily_signin.xflow.map.json", "__init__.py"]) {
      const read = reread({ ...raw, files: raw.files.filter((file) => file.path !== path) });
      expect(read.ok, path).toBe(false);
      if (!read.ok) expect([read.reason, read.detail]).toEqual(["missing", path]);
    }
  });

  it("requires the exact entry stub, so a pushed bundle stays recognisable as an editor project", () => {
    const read = reread(withFile(sampleRaw(), "__init__.py", entryStub("daily_signin") + "import os\nos.system('x')\n"));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("entry");
  });

  it("requires a flow text that parses and names the project", () => {
    const broken = reread(withFile(sampleRaw(), "flows/daily_signin.xflow", "this is not a flow"));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toBe("flow");
    const renamed = printFlow({ ...parse(SAMPLE_FLOW), name: "other_flow" });
    const wrong = reread(withFile(sampleRaw(), "flows/daily_signin.xflow", renamed));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect([wrong.reason, wrong.detail]).toEqual(["flow", "other_flow"]);
  });

  it("requires a source map for the build and a well-formed layout", () => {
    const mapPath = "flows/daily_signin.xflow.map.json";
    for (const content of ["{", JSON.stringify({ version: 1, file: "main.py", lines: {}, nodes: {} }), JSON.stringify({ version: 2, file: "flows/daily_signin.py", lines: {}, nodes: {} })]) {
      const read = reread(withFile(sampleRaw(), mapPath, content));
      expect(read.ok, content).toBe(false);
      if (!read.ok) expect(read.reason).toBe("map");
    }
    const layoutPath = "flows/daily_signin.xflow.layout.json";
    for (const content of ["[", JSON.stringify({ xflowLayout: 2, nodes: {} }), JSON.stringify({ xflowLayout: 1 })]) {
      const read = reread(withFile(sampleRaw(), layoutPath, content));
      expect(read.ok, content).toBe(false);
      if (!read.ok) expect(read.reason).toBe("layout");
    }
  });
});
