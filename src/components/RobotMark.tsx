export function RobotMark({ size = 44 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <path d="M31 11V5" stroke="#2871ae" strokeWidth="4" strokeLinecap="round"/><circle cx="31" cy="5" r="4" fill="#E84A5F"/>
    <rect x="4" y="26" width="9" height="20" rx="4" fill="#2674bb"/><rect x="51" y="26" width="9" height="20" rx="4" fill="#2674bb"/>
    <rect x="11" y="14" width="42" height="42" rx="16" fill="#dcb847"/>
    <rect x="11" y="11" width="42" height="40" rx="16" fill="#F4D758"/>
    <rect x="17" y="22" width="30" height="17" rx="8" fill="#234963"/>
    <path d="M24 28v4m16-4v4" stroke="#fefcf6" strokeWidth="4" strokeLinecap="round"/>
    <path d="M28 43q4 4 8 0" fill="none" stroke="#a47b28" strokeWidth="2.5" strokeLinecap="round"/>
  </svg>;
}
