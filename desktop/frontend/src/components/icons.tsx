import type { ReactNode, SVGProps } from "react";

// Inline 24×24 stroke icons: vectors stay crisp at any DPI and nothing is fetched (CSP: no remote assets).
function Svg({ children, size = 18, ...rest }: { children: ReactNode; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}
type P = { size?: number };

export const IconPhone = (p: P) => (<Svg {...p}><rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M11 18.5h2" /></Svg>);
export const IconUsb = (p: P) => (<Svg {...p}><path d="M12 3v13" /><circle cx="12" cy="19" r="2" /><path d="M12 8l-4 2.5v2" /><rect x="6.5" y="12.5" width="3" height="3" rx=".6" /><path d="M12 6l3 2v2" /><circle cx="15.5" cy="11.5" r="1.3" /></Svg>);
export const IconWifi = (p: P) => (<Svg {...p}><path d="M2.5 9a15 15 0 0 1 19 0" /><path d="M5.5 12.5a10.5 10.5 0 0 1 13 0" /><path d="M8.7 16a6 6 0 0 1 6.6 0" /><circle cx="12" cy="19.3" r=".8" fill="currentColor" /></Svg>);
export const IconRefresh = (p: P) => (<Svg {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></Svg>);
export const IconCamera = (p: P) => (<Svg {...p}><path d="M4 8h3l1.6-2.5h6.8L17 8h3v11H4z" /><circle cx="12" cy="13.2" r="3.4" /></Svg>);
export const IconSun = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></Svg>);
export const IconMoon = (p: P) => (<Svg {...p}><path d="M20 14.6A8.2 8.2 0 0 1 9.4 4 8.2 8.2 0 1 0 20 14.6z" /></Svg>);
export const IconMonitor = (p: P) => (<Svg {...p}><rect x="3" y="4" width="18" height="12.5" rx="2" /><path d="M8.5 20.5h7M12 16.5v4" /></Svg>);
export const IconAlert = (p: P) => (<Svg {...p}><path d="M12 3.5l9.5 16.5h-19z" /><path d="M12 10v4.2" /><circle cx="12" cy="17.2" r=".7" fill="currentColor" /></Svg>);
export const IconInfo = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><circle cx="12" cy="7.8" r=".7" fill="currentColor" /></Svg>);
export const IconSearch = (p: P) => (<Svg {...p}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21" /></Svg>);
export const IconLink = (p: P) => (<Svg {...p}><path d="M9.5 14.5l5-5" /><path d="M11 6.5l1.2-1.2a4 4 0 0 1 5.6 5.6L16.5 12" /><path d="M13 17.5l-1.2 1.2a4 4 0 0 1-5.6-5.6L7.5 12" /></Svg>);
export const IconUnlink = (p: P) => (<Svg {...p}><path d="M11 6.5l1.2-1.2a4 4 0 0 1 5.6 5.6L16.5 12" /><path d="M13 17.5l-1.2 1.2a4 4 0 0 1-5.6-5.6L7.5 12" /><path d="M4 4l16 16" /></Svg>);
export const IconFolder = (p: P) => (<Svg {...p}><path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>);
export const IconFlow = (p: P) => (<Svg {...p}><rect x="3" y="3.5" width="6.5" height="6" rx="1.4" /><rect x="14.5" y="14.5" width="6.5" height="6" rx="1.4" /><path d="M9.5 6.5h3.5a2 2 0 0 1 2 2v6" /></Svg>);
export const IconGrid = (p: P) => (<Svg {...p}><rect x="3.5" y="3.5" width="7" height="7" rx="1.4" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.4" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.4" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.4" /></Svg>);
export const IconPlus = (p: P) => (<Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>);
export const IconChevron = (p: P) => (<Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>);
export const IconMark = (p: P) => (<Svg {...p}><path d="M5 5l14 14M19 5L5 19" strokeWidth={2.4} /></Svg>);

export function Spinner() {
  return <span className="spinner" role="presentation" aria-hidden="true" />;
}
export const IconSidebar = (p: P) => (<Svg {...p}><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M9.5 4.5v15" /></Svg>);
