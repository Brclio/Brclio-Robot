import { levels } from '../../data/levels';
import { loadSave, saveData, STORAGE_KEY } from '../../storage';
import { emptyProgress, mergeProgress, validateProgress, type ProgressData } from '../../shared/progress.mjs';
import type { SaveData } from '../../types';

export const SYNC_DEBOUNCE_MS = 5_000;
export const SYNC_MIN_INTERVAL_MS = 30_000;
export const SYNC_MAX_WAIT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
export const LOGOUT_SYNC_BUDGET_MS = 1_500;
const MAX_AUTOMATIC_RETRIES = 4;
const META_LIMIT = 4_000_000;

export const accountStorageKey = (id: string) => `${STORAGE_KEY}.account.${encodeURIComponent(id)}`;
const storageKey = (id: string | null | undefined) => id ? accountStorageKey(id) : STORAGE_KEY;
const hasBlocks = (program: SaveData['drafts'][string]) => program.main.length > 0 || program.functions.A.length > 0 || program.functions.B.length > 0;

/** A stable representation also detects records whose object key insertion order differs. */
export function signature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(signature).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${signature(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

interface Metadata { version: 1; progress: ProgressData; syncedSignature: string; lastWriteAt: number }
interface SyncState { status: string; storageError: string }
interface ControllerOptions {
  initialSave: SaveData;
  onSave: (save: SaveData) => void;
  onState: (state: SyncState) => void;
  onBeforeApply?: () => void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

class SyncHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** One controller per mounted playground: local first, account isolated, and no idle polling. */
export class ProgressSyncController {
  private save: SaveData;
  private displayedSave: SaveData;
  private activeUser: string | null | undefined;
  private requestedUser: string | null | undefined;
  private progress = emptyProgress();
  private syncedSignature = '';
  private lastWriteAt = 0;
  private canApply = true;
  private needsRead = false;
  private pendingApply = false;
  private firstChangeAt = 0;
  private failureCount = 0;
  private sessionInvalid = false;
  private revision = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private timeout?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private abort?: AbortController;
  private state: SyncState = { status: '保存在此浏览器', storageError: '' };
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(private readonly options: ControllerOptions) {
    this.save = structuredClone(options.initialSave);
    this.displayedSave = structuredClone(options.initialSave);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.progress = this.readMetadata(STORAGE_KEY, this.save).progress;
  }

  /** `undefined` means that the session is still being checked, rather than a logout. */
  update(save: SaveData, userId: string | null | undefined, canApply: boolean): void {
    this.displayedSave = structuredClone(save);
    this.canApply = canApply;
    this.requestedUser = userId;
    // Capture real edits before a transition, using the outgoing account's namespace.
    if (signature(save) !== signature(this.save)) {
      this.recordChanges(save);
      this.save = structuredClone(save);
      this.persist();
      this.markPending();
    }
    if (this.activeUser !== userId && canApply) this.selectUser(userId);
    if (this.pendingApply && canApply && this.activeUser === this.requestedUser) this.applyProgress();
  }

  start(): void {
    this.stopped = false;
    if (!this.sessionInvalid && (this.needsRead || this.dirty)) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.revision++;
    this.clearTimer();
    if (this.timeout) clearTimeout(this.timeout);
    this.abort?.abort();
    this.abort = undefined;
    this.inFlight = undefined;
  }

  retry = (): void => {
    if (!this.activeUser || this.stopped) return;
    this.failureCount = 0;
    this.sessionInvalid = false;
    this.needsRead = true;
    this.schedule(0);
  };

  flush = async (): Promise<void> => {
    if (!this.activeUser || this.stopped || this.sessionInvalid) return;
    const revision = this.revision;
    const current = () => !this.stopped && !this.sessionInvalid && Boolean(this.activeUser) && revision === this.revision;
    this.clearTimer();
    if (this.inFlight) { await this.inFlight; }
    if (!current()) return;
    if (this.needsRead) { await this.readRemote(); }
    if (!current()) return;
    if (this.dirty && !this.needsRead) {
      if (this.now() - this.lastWriteAt < SYNC_MIN_INTERVAL_MS) this.schedule(this.lastWriteAt + SYNC_MIN_INTERVAL_MS - this.now());
      else await this.writeRemote();
    }
  };

  /** The latest edits remain in the account cache even when logout happens offline. */
  prepareLogout = async (): Promise<void> => {
    this.persist();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.flush(), new Promise<void>(resolve => { timeout = setTimeout(resolve, LOGOUT_SYNC_BUDGET_MS); })]);
    } finally { if (timeout) clearTimeout(timeout); }
  };

  /** Best effort only. The persistent pending copy is the source of truth after a closed tab. */
  pageHide = (): void => {
    this.persist();
    if (!this.activeUser || this.sessionInvalid || this.needsRead || this.inFlight || !this.dirty || this.now() - this.lastWriteAt < SYNC_MIN_INTERVAL_MS) return;
    const body = JSON.stringify({ progress: this.progress });
    if (new TextEncoder().encode(body).length > 60_000) return;
    void this.fetcher('/api/progress', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Brclio-User-Id': this.activeUser }, body, keepalive: true }).catch(() => undefined);
    this.lastWriteAt = this.now();
    this.persist();
    // Do not mark a fire-and-forget request acknowledged; next login will safely merge it.
  };

  private get dirty(): boolean { return signature(this.progress) !== this.syncedSignature; }

  private setState(status: string, storageError = this.state.storageError): void {
    this.state = { status, storageError };
    if (!this.stopped) this.options.onState(this.state);
  }

  private readMetadata(key: string, fallback: SaveData): Metadata {
    try {
      const raw = globalThis.localStorage.getItem(`${key}.sync`);
      if (raw && raw.length <= META_LIMIT) {
        const data = JSON.parse(raw) as Metadata;
        if (data.version === 1 && validateProgress(data.progress, this.now()) && typeof data.syncedSignature === 'string'
          && Number.isSafeInteger(data.lastWriteAt) && data.lastWriteAt >= 0 && data.lastWriteAt <= this.now() + 300_000) return data;
      }
    } catch { /* Existing SaveData remains recoverable if only sync metadata was damaged. */ }
    const progress = emptyProgress();
    for (const [id, program] of Object.entries(fallback.drafts)) {
      if (hasBlocks(program)) progress.drafts[id] = { program: structuredClone(program), updatedAt: this.now() };
    }
    progress.completed = structuredClone(fallback.completed);
    return { version: 1, progress, syncedSignature: '', lastWriteAt: 0 };
  }

  private persist(): void {
    const key = storageKey(this.activeUser);
    let error = saveData(this.save, key) ?? '';
    try {
      const metadata: Metadata = { version: 1, progress: this.progress, syncedSignature: this.syncedSignature, lastWriteAt: this.lastWriteAt };
      const text = JSON.stringify(metadata);
      if (text.length > META_LIMIT) throw new Error('quota');
      globalThis.localStorage.setItem(`${key}.sync`, text);
    } catch { error ||= '同步记录暂时无法保存在浏览器，请用导出按钮备份重要程序。'; }
    if (error !== this.state.storageError) this.setState(this.state.status, error);
  }

  private recordChanges(next: SaveData): void {
    for (const [id, program] of Object.entries(next.drafts)) {
      if (signature(program) !== signature(this.save.drafts[id])) {
        this.progress.drafts[id] = { program: structuredClone(program), updatedAt: Math.max(this.now(), (this.progress.drafts[id]?.updatedAt ?? 0) + 1) };
      }
    }
    this.progress = mergeProgress(this.progress, { version: 1, drafts: {}, completed: next.completed });
  }

  private selectUser(userId: string | null | undefined): void {
    this.persist();
    this.revision++;
    this.abort?.abort();
    this.abort = undefined;
    this.inFlight = undefined;
    if (this.timeout) clearTimeout(this.timeout);
    this.clearTimer();
    const outgoingWasGuest = !this.activeUser;
    const guestProgress = outgoingWasGuest ? this.progress : this.readMetadata(STORAGE_KEY, loadSave(levels).data).progress;
    const guestSave = outgoingWasGuest ? this.save : loadSave(levels).data;
    this.activeUser = userId;
    this.pendingApply = false;
    this.failureCount = 0;
    this.sessionInvalid = false;
    this.firstChangeAt = 0;
    if (!userId) {
      const metadata = this.readMetadata(STORAGE_KEY, guestSave);
      this.save = structuredClone(guestSave);
      this.progress = metadata.progress;
      this.syncedSignature = '';
      this.lastWriteAt = 0;
      this.needsRead = false;
      this.emitSave(this.save);
      this.setState('保存在此浏览器');
      this.persist();
      return;
    }
    const key = accountStorageKey(userId);
    const cached = loadSave(levels, key).data;
    const metadata = this.readMetadata(key, cached);
    this.progress = mergeProgress(metadata.progress, guestProgress);
    this.syncedSignature = metadata.syncedSignature;
    this.lastWriteAt = metadata.lastWriteAt;
    let hasCachedSave = false;
    try { hasCachedSave = globalThis.localStorage.getItem(key) !== null; } catch { /* A blocked cache still permits cloud recovery. */ }
    this.save = { ...cached, currentLevel: hasCachedSave ? cached.currentLevel : guestSave.currentLevel, settings: { ...guestSave.settings } };
    this.needsRead = true;
    this.applyProgress();
    this.setState('正在合并历史记录…');
    this.schedule(0);
  }

  private applyProgress(): void {
    if (!this.canApply) { this.pendingApply = true; this.persist(); return; }
    const next = structuredClone(this.save);
    for (const [id, record] of Object.entries(this.progress.drafts)) next.drafts[id] = structuredClone(record.program);
    next.completed = structuredClone(this.progress.completed);
    this.pendingApply = false;
    this.save = next;
    this.emitSave(next);
    this.persist();
  }

  private emitSave(next: SaveData): void {
    if (signature(next) === signature(this.displayedSave)) return;
    const levelChanged = next.currentLevel !== this.displayedSave.currentLevel;
    const programChanged = signature(next.drafts[next.currentLevel]) !== signature(this.displayedSave.drafts[this.displayedSave.currentLevel]);
    if (levelChanged || programChanged) this.options.onBeforeApply?.();
    this.displayedSave = structuredClone(next);
    this.options.onSave(structuredClone(next));
  }

  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  private schedule(delay: number): void {
    if (this.stopped || !this.activeUser) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, Math.max(0, delay));
  }

  private markPending(): void {
    if (!this.activeUser) { this.setState('保存在此浏览器'); return; }
    if (this.sessionInvalid) return;
    if (!this.dirty) return;
    const now = this.now();
    this.firstChangeAt ||= now;
    this.setState('已保存到浏览器，稍后同步');
    const due = Math.max(this.lastWriteAt + SYNC_MIN_INTERVAL_MS, Math.min(now + SYNC_DEBOUNCE_MS, this.firstChangeAt + SYNC_MAX_WAIT_MS));
    this.schedule(due - now);
  }

  private async request(method: 'GET' | 'PUT', progress?: ProgressData): Promise<ProgressData> {
    const abort = new AbortController();
    this.abort = abort;
    const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    this.timeout = timeout;
    try {
      const response = await this.fetcher('/api/progress', {
        method, credentials: 'same-origin', signal: abort.signal,
        headers: { 'X-Brclio-User-Id': this.activeUser ?? '', ...(progress ? { 'Content-Type': 'application/json' } : {}) },
        ...(progress ? { body: JSON.stringify({ progress }) } : {}),
      });
      if (!response.ok) {
        throw new SyncHttpError(response.status === 401 ? '登录已过期，请重新登录后同步' : response.status === 409 ? '账号已在其他页面切换，请刷新后重试' : '云端暂时未连接，记录已保存在浏览器', response.status);
      }
      const body = await response.json() as { progress?: unknown };
      if (body.progress === null && method === 'GET') return emptyProgress();
      if (!validateProgress(body.progress, this.now())) throw new Error('云端记录格式异常，本地记录已保留');
      return body.progress;
    } finally {
      clearTimeout(timeout);
      if (this.timeout === timeout) this.timeout = undefined;
    }
  }

  private failed(error: unknown): void {
    this.failureCount++;
    if (error instanceof SyncHttpError && (error.status === 401 || error.status === 409)) this.sessionInvalid = true;
    this.setState(error instanceof Error && error.name !== 'AbortError' ? error.message : '云端暂时未连接，记录已保存在浏览器');
    this.persist();
    if (!this.sessionInvalid && this.failureCount <= MAX_AUTOMATIC_RETRIES) this.schedule(Math.min(15_000 * 2 ** (this.failureCount - 1), 120_000));
  }

  private async readRemote(): Promise<void> {
    if (this.inFlight || !this.activeUser || this.stopped || this.sessionInvalid) return;
    const revision = this.revision;
    this.inFlight = (async () => {
      try {
        const remote = await this.request('GET');
        if (this.stopped || revision !== this.revision) return;
        this.needsRead = false;
        this.failureCount = 0;
        this.syncedSignature = signature(remote);
        this.progress = mergeProgress(this.progress, remote);
        this.applyProgress();
        this.setState(this.dirty ? '历史已合并，正在同步…' : '历史已同步');
      } catch (error) {
        if (!this.stopped && revision === this.revision) this.failed(error);
      } finally { if (revision === this.revision) this.inFlight = undefined; }
    })();
    await this.inFlight;
  }

  private async writeRemote(): Promise<void> {
    if (this.inFlight || !this.activeUser || !this.dirty || this.stopped || this.sessionInvalid) return;
    const revision = this.revision;
    const sent = structuredClone(this.progress);
    this.setState('正在同步历史记录…');
    this.inFlight = (async () => {
      try {
        const remote = await this.request('PUT', sent);
        if (this.stopped || revision !== this.revision) return;
        this.lastWriteAt = this.now();
        this.failureCount = 0;
        this.firstChangeAt = 0;
        this.syncedSignature = signature(remote);
        this.progress = mergeProgress(this.progress, remote);
        this.applyProgress();
        if (this.dirty) this.markPending();
        else { this.clearTimer(); this.setState('历史已同步'); }
      } catch (error) {
        if (!this.stopped && revision === this.revision) this.failed(error);
      } finally { if (revision === this.revision) this.inFlight = undefined; }
    })();
    await this.inFlight;
  }
}
