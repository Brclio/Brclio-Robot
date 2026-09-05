import type { CSSProperties } from 'react';
import type { Level, RuntimeState, Settings } from '../../types';
const directions = { N: { angle: 0, text: '北 ↑' }, E: { angle: 90, text: '东 →' }, S: { angle: 180, text: '南 ↓' }, W: { angle: 270, text: '西 ←' } };
const cell = 64;
function StarShape({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`}><path d="m0-18 5.6 11.4 12.6 1.8-9.1 8.9 2.1 12.5L0 10.7l-11.2 5.9 2.1-12.5-9.1-8.9 12.6-1.8Z" fill="#F4D758" stroke="#cfaa37" strokeWidth="1.8" strokeLinejoin="round" /><path d="m-5-2 4-7" stroke="#fff4c0" strokeWidth="3" strokeLinecap="round" /></g>;
}
export function RobotMap({ level, runtime, settings, resetKey }: { level: Level; runtime: RuntimeState; settings: Settings; resetKey: number }) {
  const width = level.width * cell, height = level.height * cell;
  const { robot } = runtime;
  return <div className="map-display">
    <svg className="robot-map" data-testid="robot-map" viewBox={`-30 -30 ${width + 60} ${height + 60}`} role="img" aria-label={`机器人地图，${level.width}列${level.height}行。当前位置(${robot.x}, ${robot.y})，朝${directions[robot.direction].text}`}>
      <defs>
        <pattern id="map-grain" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".6" fill="#507b57" opacity=".10" /></pattern>
      </defs>
      <rect x="-4" y="1" width={width + 8} height={height + 8} rx="17" fill="#c4d4b7" />
      <rect x="-4" y="-4" width={width + 8} height={height + 8} rx="17" fill="#dde6ce" />
      {Array.from({ length: level.height }, (_, y) => Array.from({ length: level.width }, (_, x) => <g key={`${x},${y}`}>
        <rect x={x * cell + 1} y={y * cell + 1} width={cell - 2} height={cell - 2} rx="5" fill={(x + y) % 2 ? '#eef1df' : '#e8edda'} />
        <rect x={x * cell + 1} y={y * cell + 1} width={cell - 2} height={cell - 2} rx="5" fill="url(#map-grain)" />
      </g>))}
      {Array.from({ length: level.width }, (_, x) => <text key={x} x={x * cell + 32} y="-14" textAnchor="middle" className="coordinate">{x}</text>)}
      {Array.from({ length: level.height }, (_, y) => <text key={y} x="-17" y={y * cell + 36} textAnchor="middle" className="coordinate">{y}</text>)}
      <g transform={`translate(${level.start.x * cell + 32} ${level.start.y * cell + 32})`}><rect x="-23" y="-23" width="46" height="46" rx="14" fill="#c9dfe4" stroke="#8eb8c6" strokeDasharray="4 4" /><text y="5" textAnchor="middle" fontSize="11" fill="#367589" fontWeight="700">起点</text></g>
      {settings.trail && runtime.trail.length > 1 && <polyline data-testid="movement-trail" points={runtime.trail.map(p => `${p.x * cell + 32},${p.y * cell + 32}`).join(' ')} fill="none" stroke="#2B7FD8" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 10" opacity=".6" />}
      {level.obstacles.map(p => <g key={`${p.x},${p.y}`} transform={`translate(${p.x * cell + 32} ${p.y * cell + 32})`}>
        <ellipse cy="16" rx="22" ry="7" fill="#ced5c1" /><path d="m-22 10 6-23 22-7 17 17-3 17-26 4Z" fill="#a8bca6" /><path d="m-16-13 22-7 5 22-22 7-11 1Z" fill="#bfccb3" /><path d="m11 2 12-5-3 17-26 4-5-9Z" fill="#91a98f" /><path d="m-12-10 8-3" stroke="#d7e1c9" strokeWidth="3" strokeLinecap="round" />
      </g>)}
      {level.goal && <g transform={`translate(${level.goal.x * cell + 32} ${level.goal.y * cell + 32})`}>
        <ellipse cy="19" rx="19" ry="6" fill="#e0d7bd" /><path d="M-8 17v-38" stroke="#8b745d" strokeWidth="3.5" strokeLinecap="round" /><path d="M-6-21c10-6 14 5 27-1v21C8 6 4-5-6 1Z" fill="#E84A5F" /><path d="m1-10 4 4 8-9" stroke="#fefcf6" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>}
      {level.stars.filter(s => !runtime.collected.includes(s.id)).map(s => <StarShape key={s.id} x={s.x * cell + 32} y={s.y * cell + 32} />)}
      <g key={resetKey} className="robot-position" data-testid="robot" data-x={robot.x} data-y={robot.y} data-direction={robot.direction}
        style={{ transform: `translate(${robot.x * cell + 32}px, ${robot.y * cell + 32}px)`, '--move-time': settings.reducedMotion ? '0ms' : `${400 / settings.speed}ms` } as CSSProperties}>
        <ellipse cy="21" rx="24" ry="8" fill="#324f50" opacity=".13" />
        <g transform={`rotate(${directions[robot.direction].angle})`}>
          <path d="m0-30-6 7h12Z" fill="#276aa5" />
          <rect x="-28" y="-10" width="9" height="31" rx="4" fill="#3d6473" /><rect x="19" y="-10" width="9" height="31" rx="4" fill="#3d6473" />
          <rect x="-22" y="-21" width="44" height="47" rx="16" fill="#c49d35" />
          <rect x="-22" y="-24" width="44" height="46" rx="16" fill="#F4D758" />
          <rect x="-16" y="-17" width="32" height="20" rx="9" fill="#254e67" />
          <path d="M-9-10v5m18-5v5" stroke="#fefcf6" strokeWidth="4" strokeLinecap="round" />
          <path d="M-5 10q5 4 10 0" fill="none" stroke="#a7822c" strokeWidth="2" strokeLinecap="round" />
          <circle cx="0" cy="17" r="2" fill="#E84A5F" />
        </g>
      </g>
    </svg>
    <div className="map-caption"><span className="map-location" data-testid="robot-position">位置 ({robot.x}, {robot.y})<i />朝{directions[robot.direction].text}</span><span className="map-scale">{level.width} × {level.height} 格</span></div>
  </div>;
}
