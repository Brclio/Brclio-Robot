import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Player } from '../engine';
import { emptyProgram, type Level, type PlayerSnapshot, type Program } from '../types';

const level = (overrides: Partial<Level> = {}): Level => ({ id: 'player', number: 0, title: '测试', story: '', objective: '', chapter: '',
  width: 8, height: 8, start: { x: 1, y: 1, direction: 'E' }, obstacles: [], stars: [],
  allowed: ['forward', 'backward', 'left', 'right', 'repeat', 'call'], hints: [], solution: emptyProgram(), mode: 'free', ...overrides });
const straight = (steps = 3): Program => ({ main: [{ id: 'forward', type: 'forward', steps }], functions: { A: [], B: [] } });

describe('serial player and cancellation acceptance', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('7. pause waits for the current display interval, then resume keeps exact progress', () => {
    const player = new Player(level(), () => undefined);
    player.run(straight());
    expect(player.getSnapshot()).toMatchObject({ status: 'running', runtime: { actions: 1, robot: { x: 2 } } });
    player.pause();
    expect(player.getSnapshot().status).toBe('pausing');
    vi.advanceTimersByTime(600);
    expect(player.getSnapshot()).toMatchObject({ status: 'paused', runtime: { actions: 1, robot: { x: 2 } } });
    vi.advanceTimersByTime(60_000);
    expect(player.getSnapshot().runtime.actions).toBe(1);
    player.resume();
    expect(player.getSnapshot()).toMatchObject({ status: 'running', runtime: { actions: 2, robot: { x: 3 } } });
    vi.advanceTimersByTime(600);
    expect(player.getSnapshot()).toMatchObject({ status: 'finished', runtime: { actions: 3, robot: { x: 4 } } });
  });
  it('8. reset cancels old timers and restores independent initial state', () => {
    const changes: PlayerSnapshot[] = []; const player = new Player(level({ stars: [{ id: 's', x: 2, y: 1 }] }), state => changes.push(state));
    player.run(straight()); player.reset(); const count = changes.length;
    vi.runAllTimers();
    expect(changes).toHaveLength(count);
    expect(player.getSnapshot()).toMatchObject({ status: 'idle', runtime: { actions: 0, robot: { x: 1 }, collected: [] } });
  });
  it('8. switching levels while running prevents old task from moving the new robot', () => {
    const player = new Player(level(), () => undefined);
    player.run(straight()); player.setLevel(level({ id: 'other', start: { x: 4, y: 6, direction: 'N' } }));
    vi.runAllTimers();
    expect(player.getSnapshot()).toMatchObject({ status: 'idle', runtime: { actions: 0, robot: { x: 4, y: 6, direction: 'N' } } });
    player.run(straight(1));
    expect(player.getSnapshot().runtime.robot).toEqual({ x: 4, y: 5, direction: 'N' });
  });
  it('disposed players never emit or accept new work', () => {
    const callback = vi.fn(); const player = new Player(level(), callback);
    player.run(straight()); player.dispose(); callback.mockClear(); vi.runAllTimers();
    player.run(straight()); player.step(straight()); player.reset(); player.resume(); player.pause();
    expect(callback).not.toHaveBeenCalled();
  });
  it('repeated run clicks cannot start concurrent executions', () => {
    const player = new Player(level(), () => undefined);
    player.run(straight()); player.run(straight()); player.run(straight());
    expect(vi.getTimerCount()).toBe(1);
    vi.runAllTimers();
    expect(player.getSnapshot().runtime.actions).toBe(3);
    expect(player.getSnapshot().runtime.robot.x).toBe(4);
  });
  it('run always starts again from the initial robot and stars after completion', () => {
    const player = new Player(level({ stars: [{ id: 's', x: 2, y: 1 }] }), () => undefined);
    player.run(straight()); vi.runAllTimers();
    player.run(straight());
    expect(player.getSnapshot().runtime).toMatchObject({ robot: { x: 2 }, collected: ['s'], actions: 1 });
  });
  it('single stepping is atomic and immediately completes the final action', () => {
    const player = new Player(level(), () => undefined);
    player.step(straight()); expect(player.getSnapshot()).toMatchObject({ status: 'paused', runtime: { actions: 1 } });
    player.step(straight()); expect(player.getSnapshot()).toMatchObject({ status: 'paused', runtime: { actions: 2 } });
    player.step(straight()); expect(player.getSnapshot()).toMatchObject({ status: 'finished', runtime: { actions: 3 } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('paused execution uses the captured program even if the source is changed', () => {
    const code = straight(); const player = new Player(level(), () => undefined);
    player.step(code); code.main[0] = { id: 'right', type: 'right' };
    player.step(code);
    expect(player.getSnapshot().runtime).toMatchObject({ actions: 2, robot: { x: 3, direction: 'E' } });
  });
  it('preserves loop and function progress across pause and resume', () => {
    const code: Program = { main: [{ id: 'call', type: 'call', fn: 'A' }], functions: { A: [{ id: 'loop', type: 'repeat', times: 4, body: [{ id: 'turn', type: 'right' }] }], B: [] } };
    const player = new Player(level(), () => undefined);
    player.run(code); player.pause(); vi.runAllTimers();
    expect(player.getSnapshot().runtime.active).toMatchObject({ blockId: 'turn', loops: [{ current: 1 }], calls: [{ blockId: 'call', fn: 'A' }] });
    player.resume(); vi.runAllTimers();
    expect(player.getSnapshot().runtime).toMatchObject({ actions: 4, robot: { direction: 'E' } });
  });
  it.each([0.5, 1, 2] as const)('speed %s changes presentation duration only', speed => {
    const player = new Player(level(), () => undefined); player.setSpeed(speed); player.run(straight());
    vi.advanceTimersByTime(600 / speed - 1); expect(player.getSnapshot().runtime.actions).toBe(1);
    vi.advanceTimersByTime(1); expect(player.getSnapshot().runtime.actions).toBe(2);
    vi.runAllTimers();
    expect(player.getSnapshot()).toMatchObject({ status: 'finished', runtime: { actions: 3, robot: { x: 4, y: 1, direction: 'E' }, budgetUsed: 4 } });
  });
  it('reset then starting a new run does not mix timers from two generations', () => {
    const player = new Player(level(), () => undefined); player.run(straight());
    vi.advanceTimersByTime(500); player.reset(); player.run(straight(2));
    vi.advanceTimersByTime(100); expect(player.getSnapshot().runtime.actions).toBe(1);
    vi.advanceTimersByTime(500); expect(player.getSnapshot().runtime.actions).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('handles a reset triggered inside the subscriber before scheduling the next frame', () => {
    let player: Player;
    player = new Player(level(), state => { if (state.runtime.actions === 1) player.reset(); });
    player.run(straight()); vi.runAllTimers();
    expect(player.getSnapshot()).toMatchObject({ status: 'idle', runtime: { actions: 0 } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('invalid programs finish with friendly feedback rather than scheduling timers', () => {
    const player = new Player(level(), () => undefined); player.run(emptyProgram());
    expect(player.getSnapshot()).toMatchObject({ status: 'finished', runtime: { status: 'error', actions: 0 } });
    expect(player.getSnapshot().runtime.message).toContain('先放一块');
    expect(vi.getTimerCount()).toBe(0);
  });
});
