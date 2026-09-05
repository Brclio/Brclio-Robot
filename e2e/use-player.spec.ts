import { expect, test, type Page } from '@playwright/test';
import type { Level, PlayerSnapshot, Program } from '../src/types';

type Harness = {
  snapshot: PlayerSnapshot; resetKey: number;
  run: (program: Program) => void; step: (program: Program) => void; reset: () => void;
  pause: () => void; resume: () => void;
};
type TestWindow = Window & {
  hookPlayer: Harness;
  hookSuccesses: { label: string; snapshot: PlayerSnapshot }[];
  hookLabel: string;
  updateHook: (props: { level?: Level; label?: string }) => void;
  unmountHook: () => void;
};
const map: Level = { id: 'hook', number: 0, title: 'hook test', chapter: '', story: '', objective: '', width: 5, height: 5,
  start: { x: 1, y: 1, direction: 'E' }, goal: { x: 2, y: 1 }, stars: [], obstacles: [], allowed: ['forward', 'right'],
  mode: 'challenge', hints: [], solution: { main: [], functions: { A: [], B: [] } } };
const code = (steps = 1): Program => ({ main: [{ id: 'move', type: 'forward', steps }], functions: { A: [], B: [] } });

async function mountHook(page: Page, level = map) {
  await page.goto('/');
  await expect(page.getByTestId('robot')).toBeVisible();
  await page.evaluate(async level => {
    // Use Vite's exact dependency URLs so this harness shares the renderer's React instance.
    const source = await (await fetch('/src/main.tsx')).text();
    const reactUrl = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    const domUrl = source.match(/from\s+["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
    if (!reactUrl || !domUrl) throw new Error('Unable to locate installed React dependencies');
    const reactModule = await import(reactUrl);
    const domModule = await import(domUrl);
    const React = reactModule.default ?? reactModule;
    const ReactDOM = domModule.default ?? domModule;
    const hookUrl = '/src/features/simulator/usePlayer.ts';
    const { usePlayer } = await import(hookUrl);
    const host = document.createElement('div'); host.hidden = true; document.body.appendChild(host);
    const root = ReactDOM.createRoot(host);
    const w = window as unknown as TestWindow; w.hookSuccesses = [];
    let props = { level, label: 'original' };
    const settings = { sound: false, speed: 1, trail: true, reducedMotion: true };
    function Probe({ level, label }: { level: Level; label: string }) {
      w.hookLabel = label;
      w.hookPlayer = usePlayer(level, settings, (snapshot: PlayerSnapshot) => w.hookSuccesses.push({ label, snapshot }));
      return null;
    }
    const render = () => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe, props)));
    w.updateHook = next => { props = { ...props, ...next }; render(); };
    w.unmountHook = () => { root.unmount(); host.remove(); };
    render();
  }, level);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookPlayer?.resetKey ?? 0)).toBeGreaterThan(0);
}

test('StrictMode hook starts one player and records every one-action replay', async ({ page }) => {
  await mountHook(page);
  expect(await page.evaluate(() => (window as unknown as TestWindow).hookPlayer.resetKey)).toBe(2);
  await page.evaluate(program => (window as unknown as TestWindow).hookPlayer.run(program), code());
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookSuccesses.length)).toBe(1);
  await page.evaluate(program => (window as unknown as TestWindow).hookPlayer.run(program), code());
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookSuccesses.length)).toBe(2);
  expect(await page.evaluate(() => (window as unknown as TestWindow).hookPlayer.snapshot.runtime.actions)).toBe(1);
});

test('step after finished creates a fresh animation session and records the new result', async ({ page }) => {
  await mountHook(page);
  await page.evaluate(program => (window as unknown as TestWindow).hookPlayer.step(program), code());
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookSuccesses.length)).toBe(1);
  const previousKey = await page.evaluate(() => (window as unknown as TestWindow).hookPlayer.resetKey);
  await page.evaluate(program => (window as unknown as TestWindow).hookPlayer.step(program), code());
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookPlayer.resetKey)).toBe(previousKey + 1);
  expect(await page.evaluate(() => (window as unknown as TestWindow).hookSuccesses.length)).toBe(2);
});

test('a paused run keeps its original completion callback across React renders', async ({ page }) => {
  await mountHook(page, { ...map, goal: { x: 3, y: 1 } });
  await page.evaluate(program => (window as unknown as TestWindow).hookPlayer.step(program), code(2));
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookPlayer.snapshot.status)).toBe('paused');
  await page.evaluate(() => (window as unknown as TestWindow).updateHook({ label: 'later render' }));
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookLabel)).toBe('later render');
  await page.evaluate(program => (window as unknown as TestWindow).hookPlayer.step(program), code(2));
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookSuccesses.length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as TestWindow).hookSuccesses[0].label)).toBe('original');
});

test('duplicate run requests do not restart animation or create another timer', async ({ page }) => {
  await mountHook(page, { ...map, goal: { x: 4, y: 1 } });
  const key = await page.evaluate(() => (window as unknown as TestWindow).hookPlayer.resetKey);
  await page.evaluate(program => { const player = (window as unknown as TestWindow).hookPlayer; player.run(program); player.run(program); player.run(program); }, code(3));
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookPlayer.resetKey)).toBe(key + 1);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookPlayer.snapshot.status)).toBe('finished');
  expect(await page.evaluate(() => ({ actions: (window as unknown as TestWindow).hookPlayer.snapshot.runtime.actions, completions: (window as unknown as TestWindow).hookSuccesses.length }))).toEqual({ actions: 3, completions: 1 });
});

test('switching levels and unmounting dispose old execution under StrictMode', async ({ page }) => {
  await mountHook(page, { ...map, goal: { x: 4, y: 1 } });
  await page.evaluate(program => (window as unknown as TestWindow).hookPlayer.run(program), code(3));
  const other = { ...map, id: 'other', start: { x: 1, y: 3, direction: 'N' as const } };
  await page.evaluate(level => (window as unknown as TestWindow).updateHook({ level }), other);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookPlayer.snapshot.runtime.robot.y)).toBe(3);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as unknown as TestWindow).hookPlayer.snapshot.runtime.actions)).toBe(0);
  await page.evaluate(program => { const w = window as unknown as TestWindow; w.hookPlayer.run(program); w.unmountHook(); }, code(3));
  await page.waitForTimeout(1_300);
  expect(await page.evaluate(() => (window as unknown as TestWindow).hookSuccesses.length)).toBe(0);
});

test('pagehide resets execution and immediately invalidates the animation key', async ({ page }) => {
  await mountHook(page);
  await page.evaluate(program => (window as unknown as TestWindow).hookPlayer.run(program), code(3));
  const key = await page.evaluate(() => (window as unknown as TestWindow).hookPlayer.resetKey);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).hookPlayer.resetKey)).toBe(key + 1);
  expect(await page.evaluate(() => (window as unknown as TestWindow).hookPlayer.snapshot)).toMatchObject({ status: 'idle', runtime: { actions: 0, robot: map.start } });
});
