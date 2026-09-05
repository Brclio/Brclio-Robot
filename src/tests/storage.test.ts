import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLevel, levels } from '../data/levels';
import { Interpreter } from '../engine/interpreter';
import { validateProgram } from '../engine/validation';
import { defaultSettings, exportProgram, importProgram, loadSave, MAX_IMPORT_CHARACTERS, saveData, STORAGE_KEY } from '../storage';
import { emptyProgram, type Program } from '../types';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  };
}

function run(program: Program, levelId: string) {
  const interpreter = new Interpreter(getLevel(levelId), program);
  let state = interpreter.getState();
  for (let i = 0; i < 2001 && state.status !== 'error' && state.status !== 'completed'; i++) state = interpreter.step();
  return state;
}

beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('independent local drafts and browser storage recovery', () => {
  it('starts with empty independent drafts, preserving settings and completion across reloads', () => {
    const { data, warning } = loadSave(levels);
    expect(warning).toBeUndefined();
    expect(data.settings).toEqual(defaultSettings);
    expect(data.drafts['001']).toEqual(emptyProgram());
    expect(data.drafts['001']).not.toBe(data.drafts['002']);
    data.drafts['001'] = structuredClone(getLevel('001').solution);
    data.drafts['012'] = structuredClone(getLevel('012').solution);
    data.currentLevel = '012';
    data.settings = { sound: true, trail: false, reducedMotion: true, speed: 2 };
    data.completed['001'] = { completedAt: '2026-09-05T10:00:00.000Z', blocks: 2, actions: 2 };
    expect(saveData(data)).toBeUndefined();
    expect(loadSave(levels)).toEqual({ data });
  });

  it('keeps unfinished functions, empty loops, and drafts above the lesson block target', () => {
    const { data } = loadSave(levels);
    data.drafts['012'] = { main: [{ id: 'unfinished', type: 'call', fn: 'A' }], functions: { A: [{ id: 'empty-repeat', type: 'repeat', times: 2, body: [] }], B: [] } };
    data.drafts['011'] = { main: [{ id: 'no-definition-yet', type: 'call', fn: 'B' }], functions: { A: [], B: [] } };
    data.drafts['007'] = { main: [1, 2, 3].map(i => ({ id: `too-many-${i}`, type: 'forward', steps: 1 })), functions: { A: [], B: [] } };
    expect(saveData(data)).toBeUndefined();
    expect(loadSave(levels)).toEqual({ data });
    expect(validateProgram(data.drafts['007'], getLevel('007')).length).toBeGreaterThan(0);
  });

  it('isolates a damaged draft while retaining other drafts and valid settings', () => {
    const { data } = loadSave(levels);
    data.drafts['002'] = getLevel('002').solution;
    const bad = JSON.parse(JSON.stringify(data));
    bad.drafts['001'] = { main: 'broken' };
    bad.settings.speed = 9;
    bad.completed['001'] = { completedAt: 'not a date', blocks: 'two', actions: -1 };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bad));
    const loaded = loadSave(levels);
    expect(loaded.warning).toContain('损坏');
    expect(loaded.data.drafts['001']).toEqual(emptyProgram());
    expect(loaded.data.drafts['002']).toEqual(getLevel('002').solution);
    expect(loaded.data.settings.speed).toBe(1);
    expect(loaded.data.completed).toEqual({});
  });

  it('handles broken JSON, unsupported versions, blocked reads and full storage without throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{broken');
    expect(loadSave(levels).warning).toContain('损坏');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99 }));
    expect(loadSave(levels).warning).toContain('版本');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } });
    const loaded = loadSave(levels);
    expect(loaded.data.drafts['001']).toEqual(emptyProgram());
    expect(loaded.warning).toContain('无法读取');
    expect(saveData(loaded.data)).toContain('没有保存成功');
  });

  it('restores fresh defaults per load without sharing mutable settings', () => {
    const first = loadSave(levels).data;
    first.settings.speed = 2;
    first.drafts['001'].main.push({ id: 'own', type: 'forward', steps: 1 });
    expect(loadSave(levels).data.settings.speed).toBe(1);
    expect(loadSave(levels).data.drafts['001'].main).toEqual([]);
  });
});

describe('safe versioned JSON programs', () => {
  it('roundtrips every reference program without changing execution semantics', () => {
    for (const level of levels) {
      const result = importProgram(exportProgram(level.solution, level.id), level);
      expect(result.error).toBeUndefined();
      expect(result.program).toEqual(level.solution);
      expect(run(result.program!, level.id)).toEqual(run(level.solution, level.id));
    }
  });

  it('can back up and import an empty board', () => {
    expect(importProgram(exportProgram(emptyProgram(), '001'), getLevel('001'))).toEqual({ program: emptyProgram() });
  });

  it('does not replace an existing valid draft when JSON is damaged or belongs to another level', () => {
    const current = structuredClone(getLevel('001').solution);
    const before = JSON.stringify(current);
    const damaged = importProgram('{', getLevel('001'));
    const other = importProgram(exportProgram(getLevel('002').solution, '002'), getLevel('001'));
    expect(damaged.error).toContain('JSON');
    expect(damaged.program).toBeUndefined();
    expect(other.error).toContain('另一个关卡');
    expect(other.program).toBeUndefined();
    expect(JSON.stringify(current)).toBe(before);
  });

  it('rejects oversized files, unsupported versions, unknown fields, HTML and code payloads', () => {
    expect(importProgram(' '.repeat(MAX_IMPORT_CHARACTERS + 1), getLevel('free')).error).toContain('太大');
    const baseline = JSON.parse(exportProgram(getLevel('free').solution, 'free'));
    const badFiles = [
      { ...baseline, version: 2 },
      { ...baseline, script: 'alert(1)' },
      { ...baseline, main: [{ id: 'bad', type: 'forward', steps: 1, html: '<img src=x onerror=alert(1)>' }] },
      { ...baseline, functions: { A: [], B: [], C: [] } },
      { ...baseline, main: [{ id: '<script>', type: 'left' }] },
      JSON.parse('{"version":1,"levelId":"free","main":[],"functions":{"A":[],"B":[]},"__proto__":{"polluted":true}}'),
    ];
    for (const file of badFiles) expect(importProgram(JSON.stringify(file), getLevel('free')).program).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('checks parameters, unknown types, missing and duplicate IDs, and nested-loop limits', () => {
    const badPrograms: unknown[] = [
      { main: [{ id: 'zero', type: 'forward', steps: 0 }], functions: { A: [], B: [] } },
      { main: [{ id: 'fraction', type: 'backward', steps: 1.5 }], functions: { A: [], B: [] } },
      { main: [{ id: 'infinite', type: 'repeat', times: 999, body: [] }], functions: { A: [], B: [] } },
      { main: [{ id: 'fly', type: 'fly' }], functions: { A: [], B: [] } },
      { main: [{ type: 'left' }], functions: { A: [], B: [] } },
      { main: [{ id: 'same', type: 'left' }], functions: { A: [{ id: 'same', type: 'right' }], B: [] } },
      { main: [{ id: 'r1', type: 'repeat', times: 2, body: [{ id: 'r2', type: 'repeat', times: 2, body: [{ id: 'r3', type: 'repeat', times: 2, body: [{ id: 'f', type: 'forward', steps: 1 }] }] }] }], functions: { A: [], B: [] } },
      { main: Array.from({ length: 201 }, (_, i) => ({ id: `node-${i}`, type: 'left' })), functions: { A: [], B: [] } },
    ];
    for (const program of badPrograms) {
      const result = importProgram(JSON.stringify({ version: 1, levelId: 'free', ...(program as object) }), getLevel('free'));
      expect(result.error).toBeTruthy();
      expect(result.program).toBeUndefined();
    }
  });

  it('rejects undefined functions, invalid references, direct and indirect recursion', () => {
    const variants: unknown[] = [
      { main: [{ id: 'main-call', type: 'call', fn: 'A' }], functions: { A: [], B: [] } },
      { main: [{ id: 'invalid', type: 'call', fn: 'C' }], functions: { A: [], B: [] } },
      { main: [{ id: 'main-call', type: 'call', fn: 'A' }], functions: { A: [{ id: 'self', type: 'call', fn: 'A' }], B: [] } },
      { main: [{ id: 'main-call', type: 'call', fn: 'A' }], functions: { A: [{ id: 'to-b', type: 'call', fn: 'B' }], B: [{ id: 'to-a', type: 'call', fn: 'A' }] } },
    ];
    for (const program of variants) expect(importProgram(JSON.stringify({ version: 1, levelId: 'free', ...(program as object) }), getLevel('free')).error).toBeTruthy();
  });

  it('enforces learned instructions and the current lesson block limit on import', () => {
    const advanced = exportProgram({ main: [{ id: 'turn', type: 'right' }], functions: { A: [], B: [] } }, '001');
    expect(importProgram(advanced, getLevel('001')).error).toContain('这一关还不能');
    const oversized: Program = { main: [1, 2, 3].map(i => ({ id: `forward-${i}`, type: 'forward', steps: 1 })), functions: { A: [], B: [] } };
    expect(importProgram(exportProgram(oversized, '007'), getLevel('007')).error).toContain('最多使用 2 块');
  });
});
