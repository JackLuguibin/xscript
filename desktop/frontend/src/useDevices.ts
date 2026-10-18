import { useEffect, useState } from "react";
import { useServices } from "./app-context";
import type { Device } from "./api";

/** Connected devices, kept current by the device.state / device.removed events Python pushes. `enabled=false`: inert. */
export function useDevices(enabled = true): Device[] {
  const { api, rpc } = useServices();
  const [devices, setDevices] = useState<Device[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void api.listDevices().then((r) => alive && setDevices(r.devices)).catch(() => undefined);
    const offState = rpc.on("device.state", (d) =>
      setDevices((cur) => {
        const dev = d as Device;
        return cur.some((x) => x.id === dev.id) ? cur.map((x) => (x.id === dev.id ? dev : x)) : [...cur, dev];
      }),
    );
    const offRemoved = rpc.on("device.removed", (d) => setDevices((cur) => cur.filter((x) => x.id !== (d as { id: string }).id)));
    return () => {
      alive = false;
      offState();
      offRemoved();
    };
  }, [api, rpc, enabled]);
  return devices;
}
