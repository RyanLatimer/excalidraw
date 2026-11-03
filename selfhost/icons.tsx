import type { CSSProperties } from "react";
const paths: Record<string, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M10 3v18M10 10h11" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  folder: (
    <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V6a4 4 0 0 1 8 0v4m-4 4v3" />
    </>
  ),
  plus: <path d="M12 4v16M4 12h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  back: <path d="m10 5-7 7 7 7M3 12h18" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  pencil: (
    <>
      <path d="m15 4 5 5M4 16 16 4a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5Z" />
    </>
  ),
  draw: (
    <>
      <path d="m15 4 5 5M9 14l7-10a2.8 2.8 0 0 1 4 4l-9 8-4 1 2-3Zm-3 6H3a2 2 0 0 1 0-4h2a2 2 0 0 0 0-4H3" />
    </>
  ),
  pin: (
    <>
      <path d="m16 3 5 5-4 2-2 6-3-1-4 4m0-4-3-3 6-2 2-4 3-3Z" />
      <path d="m3 21 5-6" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5" />
    </>
  ),
  moon: <path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" />
    </>
  ),
  check: <path d="m4 12 5 5L20 6" />,
  cloud: <path d="M6 18a5 5 0 0 1 0-10 6 6 0 0 1 11-2 6 6 0 0 1 1 12H6Z" />,
  menu: <path d="M4 5h16M4 12h16M4 19h16" />,
  restore: (
    <>
      <path d="M3 4v6h6M3 10a9 9 0 1 1 1 8m8-12v6l4 2" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  list: <path d="M8 5h13M8 12h13M8 19h13M3 5h1m-1 7h1m-1 7h1" />,
  logout: (
    <>
      <path d="M9 4H3v16h6m5-13 5 5-5 5m-5-5h11" />
    </>
  ),
};
export function Icon({ name, style }: { name: string; style?: CSSProperties }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name] || paths.folder}
    </svg>
  );
}
