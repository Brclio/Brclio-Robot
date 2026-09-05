import type { CSSProperties } from 'react';
export type IconName = 'play' | 'pause' | 'step' | 'reset' | 'sound' | 'mute' | 'help' | 'chevron' | 'check' | 'star' | 'flag' | 'map' | 'blocks' | 'download' | 'upload' | 'close' | 'bulb' | 'settings' | 'arrow';
const paths: Record<IconName, React.ReactNode> = {
  play: <path d="m9 5 11 7-11 7Z" fill="currentColor" strokeLinejoin="round" />,
  pause: <><path d="M8 5v14M16 5v14" strokeWidth="4" /></>,
  step: <><path d="m5 5 10 7-10 7Z" /><path d="M19 5v14" /></>,
  reset: <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" /></>,
  sound: <><path d="M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16" /></>,
  mute: <><path d="M11 4 6 8H3v8h3l5 4ZM16 9l6 6m0-6-6 6" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1-1.5 2M12 17h.01" /></>,
  chevron: <path d="m7 10 5 5 5-5" />,
  check: <path d="m5 12 4 4L19 6" />,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />,
  flag: <><path d="M5 21V3m0 0c5-3 9 3 14 0v10c-5 3-9-3-14 0" /></>,
  map: <><path d="m3 5 6-2 6 3 6-2v15l-6 2-6-3-6 2ZM9 3v15M15 6v15" /></>,
  blocks: <><rect x="3" y="4" width="8" height="7" rx="2" /><rect x="13" y="4" width="8" height="7" rx="2" /><rect x="3" y="14" width="8" height="7" rx="2" /><path d="M17 14v7m-3.5-3.5h7" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  bulb: <><path d="M8 17h8M9 21h6M8 14C1 7 8 0 14 3c6 2 6 7 2 11l-1 3H9Z" /></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="var(--cream)" /><circle cx="16" cy="12" r="2" fill="var(--cream)" /><circle cx="8" cy="18" r="2" fill="var(--cream)" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
};
export function Icon({ name, size = 22, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}>{paths[name]}</svg>;
}
