import { validateProgram } from '../engine/validation';
import { emptyProgram, type CompletionRecord, type Level, type Program, type ProgramFile, type SaveData, type Settings } from '../types';

export const STORAGE_KEY = 'brclio-robot.save.v1';
export const MAX_IMPORT_CHARACTERS = 250_000;
const MAX_SAVE_CHARACTERS = 2_000_000;

export const defaultSettings: Settings = { sound: false, speed: 1, trail: true, reducedMotion: false };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function freshSave(levels: Level[]): SaveData {
  return {
    version: 1,
    currentLevel: levels[0]?.id ?? '001',
    drafts: Object.fromEntries(levels.map(level => [level.id, emptyProgram()])),
    completed: {},
    settings: { ...defaultSettings },
  };
}

function validCompletion(value: unknown): value is CompletionRecord {
  return record(value) && exactKeys(value, ['completedAt', 'blocks', 'actions'])
    && typeof value.completedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value.completedAt)
    && value.completedAt.length < 40 && Number.isFinite(Date.parse(value.completedAt))
    && Number.isInteger(value.blocks) && (value.blocks as number) >= 1 && (value.blocks as number) <= 200
    && Number.isInteger(value.actions) && (value.actions as number) >= 0 && (value.actions as number) <= 2000;
}

/** Every lesson owns its own draft; a damaged entry cannot erase another lesson. */
export function loadSave(levels: Level[]): { data: SaveData; warning?: string } {
  const data = freshSave(levels);
  const damaged = new Set<string>();
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { data };
    if (raw.length > MAX_SAVE_CHARACTERS) return { data, warning: '本地存档太大，暂时无法读取。已打开新草稿，你可以导入之前的程序备份。' };
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed)) return { data, warning: '本地存档格式损坏了。已打开新草稿，你可以导入之前的程序备份。' };
    if (parsed.version !== 1) return { data, warning: '这个本地存档的版本暂不支持。已打开新草稿，原存档未被当作程序执行。' };
    if (!exactKeys(parsed, ['version', 'currentLevel', 'drafts', 'completed', 'settings'])) {
      return { data, warning: '本地存档包含缺失或不支持的字段。已打开新草稿，请使用平台导出的备份恢复。' };
    }
    const levelMap = new Map(levels.map(level => [level.id, level]));
    if (typeof parsed.currentLevel === 'string' && levelMap.has(parsed.currentLevel)) data.currentLevel = parsed.currentLevel;
    else damaged.add('当前关卡');

    if (record(parsed.drafts)) {
      for (const [id, value] of Object.entries(parsed.drafts)) {
        const level = levelMap.get(id);
        // A child can save an unfinished attempt above a lesson's block target.
        // Running and importing still enforce that target; the 200-node safety cap remains.
        if (!level || validateProgram(value, { ...level, maxBlocks: undefined }, { draft: true }).length > 0) {
          damaged.add('部分草稿');
          continue;
        }
        data.drafts[id] = structuredClone(value) as Program;
      }
    } else damaged.add('程序草稿');

    if (record(parsed.completed)) {
      for (const [id, value] of Object.entries(parsed.completed)) {
        if (levelMap.get(id)?.mode === 'challenge' && validCompletion(value)) data.completed[id] = { ...value };
        else damaged.add('部分完成记录');
      }
    } else damaged.add('完成记录');

    if (record(parsed.settings)) {
      const settings = parsed.settings;
      if (!exactKeys(settings, ['sound', 'speed', 'trail', 'reducedMotion'])) damaged.add('部分设置');
      for (const key of ['sound', 'trail', 'reducedMotion'] as const) {
        if (typeof settings[key] === 'boolean') data.settings[key] = settings[key];
        else damaged.add('部分设置');
      }
      if (settings.speed === 0.5 || settings.speed === 1 || settings.speed === 2) data.settings.speed = settings.speed;
      else damaged.add('播放速度');
    } else damaged.add('设置');

    return { data, ...(damaged.size ? { warning: `${[...damaged].join('、')}有损坏，已恢复其默认值；其余有效进度已保留。可导入程序备份继续。` } : {}) };
  } catch (error) {
    return {
      data,
      warning: error instanceof SyntaxError
        ? '本地存档无法读取，可能已经损坏。已打开新草稿，你可以导入之前的程序备份。'
        : '浏览器暂时无法读取本地存档。仍可编程和运行，请用导出按钮备份程序。',
    };
  }
}

/** Storage may be blocked or full. Report it without interrupting the playground. */
export function saveData(data: SaveData): string | undefined {
  try {
    const json = JSON.stringify(data);
    if (json.length > MAX_SAVE_CHARACTERS) return '本地存档太大，暂时无法保存。请先导出重要程序作为备份。';
    globalThis.localStorage.setItem(STORAGE_KEY, json);
    return undefined;
  } catch {
    return '浏览器没有保存成功，可能是空间不足或禁止了本地存储。当前程序仍在，请用导出按钮备份。';
  }
}

export function exportProgram(program: Program, levelId: string): string {
  const file: ProgramFile = { version: 1, levelId, main: program.main, functions: program.functions };
  return JSON.stringify(file, null, 2);
}

/** Return a validated candidate. Only the caller decides when to replace its draft. */
export function importProgram(text: string, currentLevel: Level): { program?: Program; error?: string } {
  if (text.length > MAX_IMPORT_CHARACTERS) return { error: '这个程序文件太大了，请导入本平台导出的 JSON 文件。' };
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { error: '文件不是完整的 JSON 程序。原来的积木已保留，请重新选择导出的文件。' }; }
  if (!record(value) || !exactKeys(value, ['version', 'levelId', 'main', 'functions'])) {
    return { error: '程序文件缺少必要信息，或包含不支持的字段。请使用本平台导出的 JSON 文件。' };
  }
  if (value.version !== 1) return { error: '暂不支持这个程序版本。请导入版本 1 的 Brclio Robot 程序。' };
  if (typeof value.levelId !== 'string' || value.levelId !== currentLevel.id) {
    return { error: '这个程序属于另一个关卡。请先切换到对应关卡，再导入；当前草稿已保留。' };
  }
  const candidate = { main: value.main, functions: value.functions };
  const issues = validateProgram(candidate, currentLevel, { allowEmpty: true });
  if (issues.length > 0) return { error: `没有导入：${issues[0].message} 当前草稿已保留。` };
  return { program: structuredClone(candidate) as Program };
}
