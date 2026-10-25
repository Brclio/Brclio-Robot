import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { levels } from '../../data/levels';
import { emptyProgress, mergeProgress, type ProgressData } from '../../shared/progress.mjs';
import { loadSave, STORAGE_KEY } from '../../storage';
import type { Program, SaveData } from '../../types';
import { accountStorageKey, LOGOUT_SYNC_BUDGET_MS, ProgressSyncController, SYNC_MIN_INTERVAL_MS } from './controller';

const program = (id: string, steps = 1): Program => ({ main: [{ id, type: 'forward', steps }], functions: { A: [], B: [] } });
const completion = (at: number) => ({ completedAt: new Date(at).toISOString(), blocks: 1, actions: 1 });

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(initial = loadSave(levels).data, fetcher?: typeof fetch, onBeforeApply?: () => void) {
  let save = structuredClone(initial);
  let cloud: ProgressData = emptyProgress();
  let status = '';
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PUT') cloud = mergeProgress(cloud, (JSON.parse(init.body as string) as { progress: ProgressData }).progress);
    return new Response(JSON.stringify({ progress: cloud }), { headers: { 'Content-Type': 'application/json' } });
  });
  const controller = new ProgressSyncController({ initialSave: save, onSave: next => { save = next; }, onBeforeApply, onState: state => { status = state.status; }, fetch: fetcher ?? request as typeof fetch });
  const update = (userId: string | null | undefined, patch?: (current: SaveData) => void, canApply = true) => {
    if (patch) { save = structuredClone(save); patch(save); }
    controller.update(save, userId, canApply);
  };
  controller.start();
  return { controller, request, update, get save() { return save; }, get cloud() { return cloud; }, set cloud(value: ProgressData) { cloud = value; }, get status() { return status; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T12:00:00Z')); vi.stubGlobal('localStorage', memoryStorage()); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('account-scoped, change-triggered progress synchronization', () => {
  it('keeps guests entirely local and preserves the original save namespace', async () => {
    const h = harness();
    h.update(null, save => { save.drafts['001'] = program('guest'); save.completed['001'] = completion(Date.now()); save.currentLevel = '003'; });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.request).not.toHaveBeenCalled();
    expect(loadSave(levels).data.drafts['001']).toEqual(program('guest'));
    expect(h.status).toBe('保存在此浏览器');
    h.controller.stop();
  });

  it('preserves guest edits made while the initial session is unresolved, including a StrictMode restart', async () => {
    const h = harness();
    h.update(undefined, save => { save.drafts['001'] = program('during-session-check'); });
    h.controller.stop();
    h.controller.start();
    h.update(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.request).not.toHaveBeenCalled();
    expect(loadSave(levels).data.drafts['001']).toEqual(program('during-session-check'));
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.save.drafts['001']).toEqual(program('during-session-check'));
    expect(h.cloud.drafts['001'].program).toEqual(program('during-session-check'));
    h.controller.stop();
  });

  it('restarts a canceled initial cloud read and ignores its late response after StrictMode cleanup', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? pending.promise : new Response(JSON.stringify({ progress: emptyProgress() })));
    const h = harness(undefined, fetcher as typeof fetch);
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    h.controller.stop();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve(new Response(JSON.stringify({ progress: { version: 1, drafts: { '001': { program: program('canceled-result'), updatedAt: Date.now() } }, completed: {} } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(h.save.drafts['001'].main).toHaveLength(0);
    h.controller.stop();
  });

  it('does not resume queued flushes after the playground has unmounted', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn(() => pending.promise) as typeof fetch;
    const h = harness(undefined, fetcher);
    h.update('alice', save => { save.drafts['001'] = program('never-upload-after-stop'); });
    await vi.advanceTimersByTimeAsync(0);
    const flush = h.controller.flush();
    h.controller.stop();
    pending.resolve(new Response(JSON.stringify({ progress: emptyProgress() })));
    await flush;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('merges history on login once and performs no requests while unchanged', async () => {
    const h = harness();
    h.update(null, save => { save.drafts['001'] = program('guest'); save.completed['001'] = completion(Date.now()); save.currentLevel = '003'; });
    h.cloud = { version: 1, drafts: { '002': { program: program('cloud'), updatedAt: Date.now() - 1_000 } }, completed: { '002': completion(Date.now() - 1_000) } };
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PUT']);
    expect(Object.keys(h.save.completed).sort()).toEqual(['001', '002']);
    expect(h.save.drafts['001']).toEqual(program('guest'));
    expect(h.save.drafts['002']).toEqual(program('cloud'));
    expect(h.save.currentLevel).toBe('003');
    h.update('alice');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.status).toBe('历史已同步');
    h.controller.stop();
  });

  it('guards each sync with the expected account and reads cloud changes on explicit retry', async () => {
    const h = harness();
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    h.cloud = { version: 1, drafts: { '001': { program: program('other-device'), updatedAt: Date.now() } }, completed: {} };
    h.controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.save.drafts['001']).toEqual(program('other-device'));
    for (const [, init] of h.request.mock.calls) expect((init?.headers as Record<string, string>)['X-Brclio-User-Id']).toBe('alice');
    expect(h.request.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET']);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.request).toHaveBeenCalledTimes(2);
    h.controller.stop();
  });

  it('halts automatic writes when another tab has switched the shared session', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'account changed' }), { status: 409 })) as typeof fetch;
    const h = harness(undefined, fetcher);
    h.update('alice', save => { save.drafts['001'] = program('alice-local'); });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(h.status).toContain('其他页面切换');
    expect(loadSave(levels, accountStorageKey('alice')).data.drafts['001']).toEqual(program('alice-local'));
    h.controller.stop();
  });

  it('debounces edits, enforces a 30-second write gap, and ignores settings-only changes', async () => {
    const h = harness();
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    h.update('alice', save => { save.settings.sound = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.update('alice', save => { save.drafts['001'] = program('first'); });
    await vi.advanceTimersByTimeAsync(4_000);
    h.update('alice', save => { save.drafts['001'] = program('latest'); });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledTimes(2);
    h.update('alice', save => { save.drafts['001'] = program('new'); });
    await vi.advanceTimersByTimeAsync(SYNC_MIN_INTERVAL_MS - 1);
    expect(h.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.cloud.drafts['001'].program).toEqual(program('new'));
    h.controller.stop();
  });

  it('retains new edits made while the first cloud read is pending', async () => {
    const pending = deferred<Response>();
    let requests = 0;
    let written: ProgressData | undefined;
    const fetcher = vi.fn(async (_url, init) => {
      if (++requests === 1) return pending.promise;
      written = (JSON.parse(init?.body as string) as { progress: ProgressData }).progress;
      return new Response(JSON.stringify({ progress: written }));
    }) as typeof fetch;
    const h = harness(undefined, fetcher);
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    h.update('alice', save => { save.drafts['001'] = program('edited-while-reading'); });
    pending.resolve(new Response(JSON.stringify({ progress: { version: 1, drafts: { '001': { program: program('older-cloud'), updatedAt: Date.now() - 10_000 } }, completed: {} } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.save.drafts['001']).toEqual(program('edited-while-reading'));
    expect(written?.drafts['001'].program).toEqual(program('edited-while-reading'));
    h.controller.stop();
  });

  it('serializes writes and retains edits made while a cloud write is pending', async () => {
    const pending = deferred<Response>();
    let written: ProgressData = emptyProgress();
    let writeCount = 0;
    const fetcher = vi.fn(async (_url, init) => {
      if (init?.method !== 'PUT') return new Response(JSON.stringify({ progress: emptyProgress() }));
      written = (JSON.parse(init.body as string) as { progress: ProgressData }).progress;
      if (++writeCount === 1) return pending.promise;
      return new Response(JSON.stringify({ progress: written }));
    }) as typeof fetch;
    const h = harness(undefined, fetcher);
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    h.update('alice', save => { save.drafts['001'] = program('first-version'); });
    await vi.advanceTimersByTimeAsync(5_000);
    const firstWrite = structuredClone(written);
    h.update('alice', save => { save.drafts['001'] = program('second-version'); });
    await vi.advanceTimersByTimeAsync(2_000);
    pending.resolve(new Response(JSON.stringify({ progress: firstWrite })));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.save.drafts['001']).toEqual(program('second-version'));
    expect(writeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writeCount).toBe(2);
    expect(written.drafts['001'].program).toEqual(program('second-version'));
    h.controller.stop();
  });

  it('defers remote program replacement until a running player becomes safe', async () => {
    const pending = deferred<Response>();
    const h = harness(undefined, vi.fn(() => pending.promise) as typeof fetch);
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    h.update('alice', undefined, false);
    pending.resolve(new Response(JSON.stringify({ progress: { version: 1, drafts: { '001': { program: program('remote'), updatedAt: Date.now() - 100 } }, completed: {} } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.save.drafts['001'].main).toHaveLength(0);
    h.update('alice', undefined, true);
    expect(h.save.drafts['001']).toEqual(program('remote'));
    h.controller.stop();
  });

  it('resets the runtime only when applying a different visible program or lesson', async () => {
    const beforeApply = vi.fn();
    const h = harness(undefined, undefined, beforeApply);
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    expect(beforeApply).not.toHaveBeenCalled();
    h.cloud = { version: 1, drafts: { '002': { program: program('non-visible'), updatedAt: Date.now() } }, completed: { '001': completion(Date.now()) } };
    h.controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(beforeApply).not.toHaveBeenCalled();
    h.cloud.drafts['001'] = { program: program('visible'), updatedAt: Date.now() };
    h.controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(beforeApply).toHaveBeenCalledTimes(1);
    h.controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(beforeApply).toHaveBeenCalledTimes(1);
    h.controller.stop();
  });

  it('does not hold logout for a slow cloud request and keeps its pending account cache', async () => {
    const pending = deferred<Response>();
    const h = harness(undefined, vi.fn(() => pending.promise) as typeof fetch);
    h.update('alice', save => { save.drafts['001'] = program('pending-on-logout'); });
    await vi.advanceTimersByTimeAsync(0);
    let finished = false;
    const logout = h.controller.prepareLogout().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(LOGOUT_SYNC_BUDGET_MS - 1);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await logout;
    expect(finished).toBe(true);
    expect(loadSave(levels, accountStorageKey('alice')).data.drafts['001']).toEqual(program('pending-on-logout'));
    h.controller.stop();
  });

  it('restores the guest snapshot and isolates subsequent account edits', async () => {
    const h = harness();
    h.update(null, save => { save.drafts['001'] = program('guest'); });
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    h.update('alice', save => { save.drafts['002'] = program('alice-only'); save.completed['002'] = completion(Date.now()); });
    h.update(null);
    expect(h.save.drafts['001']).toEqual(program('guest'));
    expect(h.save.drafts['002'].main).toHaveLength(0);
    expect(h.save.completed['002']).toBeUndefined();
    expect(loadSave(levels, accountStorageKey('alice')).data.completed['002']).toBeDefined();
    expect(loadSave(levels).data.completed['002']).toBeUndefined();
    h.cloud = emptyProgress();
    h.update('bob');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.save.drafts['002'].main).toHaveLength(0);
    expect(h.cloud.completed['002']).toBeUndefined();
    h.controller.stop();
  });

  it('ignores a previous account response after logout and switch', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? pending.promise : new Response(JSON.stringify({ progress: emptyProgress() })));
    const h = harness(undefined, fetcher as typeof fetch);
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    h.update(null);
    h.update('bob');
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve(new Response(JSON.stringify({ progress: { version: 1, drafts: { '001': { program: program('alice-secret'), updatedAt: Date.now() } }, completed: {} } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.save.drafts['001'].main).toHaveLength(0);
    expect(localStorage.getItem(accountStorageKey('bob'))).not.toContain('alice-secret');
    h.controller.stop();
  });

  it('does not invalidate the new account when an old account request later fails', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? pending.promise : new Response(JSON.stringify({ progress: emptyProgress() })));
    const h = harness(undefined, fetcher as typeof fetch);
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    h.update(null);
    h.update('bob');
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve(new Response('{}', { status: 409 }));
    await vi.advanceTimersByTimeAsync(0);
    h.update('bob', save => { save.drafts['001'] = program('bob-work'); });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(h.status).not.toContain('其他页面切换');
    h.controller.stop();
  });

  it('persists timestamps across reload and avoids uploading an unchanged cache again', async () => {
    const h = harness();
    h.update(null, save => { save.drafts['001'] = program('guest'); });
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    const previousCloud = structuredClone(h.cloud);
    h.controller.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    const reloaded = harness(loadSave(levels).data);
    reloaded.cloud = previousCloud;
    reloaded.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    expect(reloaded.request.mock.calls.map(([, init]) => init?.method)).toEqual(['GET']);
    expect(reloaded.cloud.drafts['001'].updatedAt).toBe(previousCloud.drafts['001'].updatedAt);
    reloaded.controller.stop();
  });

  it('keeps cleared drafts as timestamped changes instead of reviving cloud blocks', async () => {
    const h = harness();
    h.update(null, save => { save.drafts['001'] = program('old'); });
    h.update('alice');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    h.update('alice', save => { save.drafts['001'] = { main: [], functions: { A: [], B: [] } }; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.cloud.drafts['001'].program.main).toHaveLength(0);
    h.controller.stop();
  });

  it('preserves pending edits after offline errors and stops retrying automatically after a bounded backoff', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('network unavailable')) as typeof fetch;
    const h = harness(undefined, fetcher);
    h.update('alice', save => { save.drafts['001'] = program('offline-work'); });
    await vi.advanceTimersByTimeAsync(600_000);
    const attempts = vi.mocked(fetcher).mock.calls.length;
    expect(attempts).toBe(5);
    expect(loadSave(levels, accountStorageKey('alice')).data.drafts['001']).toEqual(program('offline-work'));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(attempts);
    h.controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(attempts + 1);
    h.controller.stop();
  });

  it('keeps completed program snapshots when restoring local storage', () => {
    const data = loadSave(levels).data;
    data.completed['001'] = { ...completion(Date.now()), program: structuredClone(levels[0].solution) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    expect(loadSave(levels)).toEqual({ data });
  });
});
