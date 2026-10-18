import type { NodeSpec } from "./dsl";
import { registerNodeAliases } from "./dsl";
import { applyOverlay, type OverlayPatch } from "./overlay";
import open from "../../../nodes/builtin/action.app.open.json";
import click from "../../../nodes/builtin/action.click.json";
import code from "../../../nodes/builtin/code.python.json";
import log from "../../../nodes/builtin/debug.log.json";
import get from "../../../nodes/builtin/data.get.json";
import set from "../../../nodes/builtin/data.set.json";
import must from "../../../nodes/builtin/data.must.json";
import fallback from "../../../nodes/builtin/data.default.json";
import start from "../../../nodes/builtin/event.start.json";
import branch from "../../../nodes/builtin/flow.branch.json";
import call from "../../../nodes/builtin/flow.call.json";
import def from "../../../nodes/builtin/flow.def.json";
import each from "../../../nodes/builtin/flow.for_each.json";
import range from "../../../nodes/builtin/flow.for_range.json";
import macro from "../../../nodes/builtin/flow.macro.json";
import match from "../../../nodes/builtin/flow.match.json";
import parallel from "../../../nodes/builtin/flow.parallel.json";
import sequence from "../../../nodes/builtin/flow.sequence.json";
import trial from "../../../nodes/builtin/flow.try.json";
import wait from "../../../nodes/builtin/flow.wait.json";
import waitUntil from "../../../nodes/builtin/flow.wait_until.json";
import retryNode from "../../../nodes/builtin/flow.retry.json";
import endNode from "../../../nodes/builtin/flow.end.json";
import mergeNode from "../../../nodes/builtin/flow.merge.json";
import loop from "../../../nodes/builtin/flow.while.json";
import add from "../../../nodes/builtin/math.add.json";
import toFloat from "../../../nodes/builtin/math.float.json";
import toInt from "../../../nodes/builtin/math.int.json";
import toStr from "../../../nodes/builtin/math.str.json";
import toBool from "../../../nodes/builtin/math.bool.json";
import sub from "../../../nodes/builtin/math.sub.json";
import mul from "../../../nodes/builtin/math.mul.json";
import div from "../../../nodes/builtin/math.div.json";
import mod from "../../../nodes/builtin/math.mod.json";
import eq from "../../../nodes/builtin/math.eq.json";
import ne from "../../../nodes/builtin/math.ne.json";
import lt from "../../../nodes/builtin/math.lt.json";
import gt from "../../../nodes/builtin/math.gt.json";
import le from "../../../nodes/builtin/math.le.json";
import ge from "../../../nodes/builtin/math.ge.json";
import land from "../../../nodes/builtin/logic.and.json";
import lor from "../../../nodes/builtin/logic.or.json";
import lnot from "../../../nodes/builtin/logic.not.json";
import concat from "../../../nodes/builtin/string.concat.json";
import format from "../../../nodes/builtin/string.format.json";
import slice from "../../../nodes/builtin/string.slice.json";
import contains from "../../../nodes/builtin/string.contains.json";
import replace from "../../../nodes/builtin/string.replace.json";
import split from "../../../nodes/builtin/string.split.json";
import regex from "../../../nodes/builtin/string.regex.json";
import length from "../../../nodes/builtin/string.len.json";
import floor from "../../../nodes/builtin/math.floor.json";
import random from "../../../nodes/builtin/math.random.json";
import clamp from "../../../nodes/builtin/math.clamp.json";
import at from "../../../nodes/builtin/list.at.json";
import push from "../../../nodes/builtin/list.push.json";
import drop from "../../../nodes/builtin/list.drop.json";
import sort from "../../../nodes/builtin/list.sort.json";
import filter from "../../../nodes/builtin/list.filter.json";
import mapList from "../../../nodes/builtin/list.map.json";
import key from "../../../nodes/builtin/dict.key.json";
import put from "../../../nodes/builtin/dict.put.json";
import parseJson from "../../../nodes/builtin/json.parse.json";
import dumpJson from "../../../nodes/builtin/json.dump.json";
import now from "../../../nodes/builtin/time.now.json";
import tformat from "../../../nodes/builtin/time.format.json";
import elapsed from "../../../nodes/builtin/time.diff.json";
import find from "../../../nodes/builtin/node.find.json";

type CatalogSpec = NodeSpec & {
  type: string;
  category: string;
  title: { zh: string; en: string };
  dsl: { alias: string };
};

const handwritten = [open, click, code, log, start, branch, call, def, each, range, macro, match, parallel, sequence, trial, wait, waitUntil, retryNode, endNode, mergeNode, loop, add, sub, mul, div, mod, eq, ne, lt, gt, le, ge, toFloat, toInt, toStr, toBool, floor, random, clamp, land, lor, lnot, concat, format, slice, contains, replace, split, regex, length, at, push, drop, sort, filter, mapList, key, put, parseJson, dumpJson, now, tformat, elapsed, find, get, set, must, fallback] as CatalogSpec[];
const generated = import.meta.glob("../../../nodes/generated/*.json", { eager: true, import: "default" }) as Record<string, CatalogSpec>;
const overlays = import.meta.glob("../../../nodes/overlay/*.json", { eager: true, import: "default" }) as Record<string, OverlayPatch>;

function isSpec(spec: CatalogSpec | undefined): spec is CatalogSpec {
  return Boolean(spec && typeof spec.type === "string" && spec.dsl?.alias && spec.exec && Array.isArray(spec.inputs));
}

const catalog = new Map<string, CatalogSpec>();
for (const spec of Object.values(generated)) {
  if (isSpec(spec)) catalog.set(spec.type, spec);
}
for (const spec of handwritten) catalog.set(spec.type, spec);
let appliedOverlays = 0;
for (const patch of Object.values(overlays)) {
  if (!patch || typeof patch.type !== "string") continue;
  const base = catalog.get(patch.type);
  if (!base) continue;
  catalog.set(patch.type, applyOverlay(base, patch));
  appliedOverlays += 1;
}
registerNodeAliases(catalog.values());

export function overlayCount(): number {
  return appliedOverlays;
}

export function builtinSpecs(): Map<string, NodeSpec> {
  return new Map(catalog);
}

/** stub and hidden stay out of the menu. A graph that already contains one still shows the badge. */
export function listedInMenu(availability: string | undefined): boolean {
  return availability !== "hidden" && availability !== "stub";
}

export function nodeBadge(availability: string | undefined): "partial" | "stub" | null {
  if (availability === "partial" || availability === "stub") return availability;
  return null;
}

export function menuSpecs(): import("./search").MenuSpec[] {
  return [...catalog.values()].filter((spec) => listedInMenu(spec.availability)).map((spec) => ({
    type: spec.type,
    category: spec.category,
    alias: spec.dsl.alias,
    title: spec.title.zh,
    execIn: spec.exec.in,
    inputs: spec.inputs,
    outputs: spec.outputs,
  }));
}
