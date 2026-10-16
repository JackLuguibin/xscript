import type { Device } from "./api";

/** Relative point on a thumbnail, then the same fraction of each device's own screen. */
export function relativePoint(x: number, y: number, shown: { w: number; h: number }): { fx: number; fy: number } {
  const fx = shown.w > 0 ? x / shown.w : 0;
  const fy = shown.h > 0 ? y / shown.h : 0;
  return { fx: clamp01(fx), fy: clamp01(fy) };
}

export function pointOnDevice(fx: number, fy: number, device: { w: number; h: number }): { x: number; y: number } | null {
  if (!(device.w > 0) || !(device.h > 0)) return null;
  return {
    x: clamp(Math.round(fx * device.w), 0, Math.round(device.w) - 1),
    y: clamp(Math.round(fy * device.h), 0, Math.round(device.h) - 1),
  };
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

export function onlineSelected(devices: readonly Device[], selected: ReadonlySet<string>): Device[] {
  return devices.filter((d) => d.state === "online" && selected.has(d.id));
}

/** Single-shot thumbnail. Not `/_frame/` and not a mirror stream (design §14.4: two viewer slots). */
export function thumbUrl(deviceId: string, tick: number): string {
  return `/_shot/${encodeURIComponent(deviceId)}.jpg?max=480&t=${tick}`;
}
