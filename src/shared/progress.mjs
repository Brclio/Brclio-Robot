import { levels } from '../data/levels.ts';
import { validateProgram } from '../engine/validation.ts';

const levelMap = new Map(levels.map(level => [level.id, level]));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const validTime = (value, now) => Number.isSafeInteger(value) && value >= 0 && value <= now + 300_000;

export function emptyProgress() { return { version: 1, drafts: {}, completed: {} }; }

/** Shared by browser and API: unknown fields and malformed trees never enter a save. */
export function validateProgress(value, now = Date.now()) {
  if (!object(value) || !exactKeys(value, ['version', 'drafts', 'completed']) || value.version !== 1
    || !object(value.drafts) || !object(value.completed)
    || Object.keys(value.drafts).length > levels.length || Object.keys(value.completed).length > levels.length) return false;
  for (const [id, draft] of Object.entries(value.drafts)) {
    const level = levelMap.get(id);
    if (!level || !object(draft) || !exactKeys(draft, ['program', 'updatedAt']) || !validTime(draft.updatedAt, now)
      || validateProgram(draft.program, { ...level, maxBlocks: undefined }, { draft: true }).length) return false;
  }
  for (const [id, completion] of Object.entries(value.completed)) {
    const level = levelMap.get(id);
    if (!level || level.mode !== 'challenge' || !object(completion)
      || !exactKeys(completion, completion.program === undefined ? ['completedAt', 'blocks', 'actions'] : ['completedAt', 'blocks', 'actions', 'program'])
      || typeof completion.completedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(completion.completedAt)
      || completion.completedAt.length > 39 || !validTime(Date.parse(completion.completedAt), now)
      || !Number.isInteger(completion.blocks) || completion.blocks < 1 || completion.blocks > 200
      || !Number.isInteger(completion.actions) || completion.actions < 0 || completion.actions > 2000
      || (completion.program !== undefined && validateProgram(completion.program, level).length)) return false;
  }
  return true;
}

/** Total ordering makes merge commutative, including edits stamped in the same millisecond. */
function latest(a, b, timestamp) {
  if (!a) return b;
  if (!b) return a;
  const delta = timestamp(a) - timestamp(b);
  if (delta) return delta > 0 ? a : b;
  // A legacy completion and its captured solution can share one completion time.
  if (Boolean(a.program) !== Boolean(b.program)) return a.program ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}
export function mergeProgress(a, b) {
  const left = a ?? emptyProgress(), right = b ?? emptyProgress();
  const drafts = {}, completed = {};
  for (const id of new Set([...Object.keys(left.drafts), ...Object.keys(right.drafts)])) {
    drafts[id] = latest(left.drafts[id], right.drafts[id], draft => draft.updatedAt);
  }
  for (const id of new Set([...Object.keys(left.completed), ...Object.keys(right.completed)])) {
    completed[id] = latest(left.completed[id], right.completed[id], completion => Date.parse(completion.completedAt));
  }
  return structuredClone({ version: 1, drafts, completed });
}
