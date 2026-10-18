import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Device } from "./api";
import { useConfirm } from "./components/ConfirmDialog";
import { t } from "./strings";
import { useDevices } from "./useDevices";

/** localStorage key of the device the user picked last (across pages and restarts). */
export const DEVICE_KEY = "xscript.device";

export function loadLastDevice(): string {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastDevice(id: string): void {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* storage disabled: the choice just lasts for this session */
  }
}

/**
 * Which device to show, given the list and the current pick. Sticky: once a device is shown it stays shown while it
 * is in the list, even offline (switching under the user would reload the editor). Otherwise the remembered device
 * if it is in the list, else the first online one. `sticky=false` (the current one was only a fallback, never picked
 * by the user, and nothing is unsaved): the remembered device takes over as soon as it appears.
 */
export function pickDevice(devices: Device[], current: string, remembered: string, sticky = true): string {
  const has = (id: string) => Boolean(id) && devices.some((d) => d.id === id);
  if (sticky && has(current)) return current;
  if (has(remembered)) return remembered;
  if (has(current)) return current;
  return devices.find((d) => d.state === "online")?.id ?? "";
}

export interface CurrentDevice {
  devices: Device[];
  devId: string;
  device: Device | undefined;
  /** Switch the global device. Asks first when the editor holds unsaved edits; resolves false when the user declined. */
  select: (id: string) => Promise<boolean>;
  /** Before an action that takes the current device away (e.g. 忘记): true when there is nothing to lose or the user agreed. */
  confirmLeave: (message: string) => Promise<boolean>;
}

const DeviceContext = createContext<CurrentDevice | null>(null);

function useSelection(enabled: boolean, unsaved: boolean, confirm: ((message: string) => Promise<boolean>) | null): CurrentDevice {
  const devices = useDevices(enabled);
  const [devId, setDevId] = useState("");
  const remembered = useRef(loadLastDevice());
  // true while devId is only the fallback (first online): at startup the remembered device may come online later
  const fallback = useRef(true);
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  useEffect(() => {
    const next = pickDevice(devices, devId, remembered.current, !fallback.current || unsavedRef.current);
    if (next && next === remembered.current) fallback.current = false;
    if (next !== devId) setDevId(next);
  }, [devices, devId]);
  const devRef = useRef(devId);
  devRef.current = devId;

  const confirmLeave = useCallback(async (message: string) => !unsavedRef.current || !confirm || (await confirm(message)), [confirm]);
  const select = useCallback(
    async (id: string) => {
      if (id === devRef.current) return true;
      if (!(await confirmLeave(t.confirmDiscardDevice))) return false;
      remembered.current = id;
      fallback.current = false;
      saveLastDevice(id);
      setDevId(id);
      return true;
    },
    [confirmLeave],
  );
  const device = devices.find((d) => d.id === devId);
  return useMemo(() => ({ devices, devId, device, select, confirmLeave }), [devices, devId, device, select, confirmLeave]);
}

/**
 * The app-wide current device (top-bar switcher, device-card shortcuts, mirror and projects pages). `unsaved` is the
 * editor's dirty flag: switching away, or forgetting the current device, asks first (the projects page may be hidden,
 * so the question is rendered here, not inside it).
 */
export function DeviceProvider({ unsaved, children }: { unsaved: boolean; children: ReactNode }) {
  const { confirm, dialog } = useConfirm();
  const ask = useCallback((message: string) => confirm({ message, confirmLabel: t.confirm.discard, danger: true }), [confirm]);
  const value = useSelection(true, unsaved, ask);
  return (
    <DeviceContext.Provider value={value}>
      {children}
      {dialog}
    </DeviceContext.Provider>
  );
}

/** The current device. Outside a DeviceProvider (a page rendered on its own) it keeps its own selection. */
export function useCurrentDevice(): CurrentDevice {
  const ctx = useContext(DeviceContext);
  const local = useSelection(ctx === null, false, null);
  return ctx ?? local;
}
