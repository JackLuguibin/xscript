import { useEffect, useState } from "react";
import { useServices } from "./app-context";
import type { Device } from "./api";

/** Connected devices, kept current by the device.state / device.removed events Python pushes. */
export function useDevices(): Device[] {
  const { api, rpc } = useServices();
  const [devices, setDevices] = useState<Device[]>([]);
  useEffect(() => {
    void api.listDevices().then((r) => setDevices(r.devices)).catch(() => undefined);
    const offState = rpc.on("device.state", (d) =>
      setDevices((cur) => {
        const dev = d as Device;
        return cur.some((x) => x.id === dev.id) ? cur.map((x) => (x.id === dev.id ? dev : x)) : [...cur, dev];
      }),
    );
    const offRemoved = rpc.on("device.removed", (d) => setDevices((cur) => cur.filter((x) => x.id !== (d as { id: string }).id)));
    return () => {
      offState();
      offRemoved();
    };
  }, [api, rpc]);
  return devices;
}

/** The selected device id: the first online one, re-picked when the selection disappears. */
export function useSelectedDevice(devices: Device[]): [string, (id: string) => void] {
  const [devId, setDevId] = useState("");
  const firstOnline = devices.find((d) => d.state === "online")?.id ?? "";
  useEffect(() => {
    if (!devId || !devices.some((d) => d.id === devId)) setDevId(firstOnline);
  }, [devices, devId, firstOnline]);
  return [devId, setDevId];
}
