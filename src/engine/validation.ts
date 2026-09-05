import type { Instruction, Level, Program, ValidationIssue } from '../types';

export const MAX_PROGRAM_NODES = 200;
export const MAX_LOOP_DEPTH = 2;
const MAX_STRUCTURE_DEPTH = 8;
const TYPES = new Set(['forward', 'backward', 'left', 'right', 'repeat', 'call']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

export interface ValidationOptions {
  /** Permit unfinished, empty sequences. Function references remain checked. */
  allowEmpty?: boolean;
  /** Storage-only: unfinished function references and cycles may be restored as drafts. */
  draft?: boolean;
}

/** Validate untrusted data before copying it into the editor or executing it. */
export function validateProgram(input: unknown, level: Level, options: ValidationOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (message: string, blockId?: string) => { issues.push({ message, ...(blockId ? { blockId } : {}) }); };
  if (!record(input) || !exactKeys(input, ['main', 'functions']) || !Array.isArray(input.main)
    || !record(input.functions) || !exactKeys(input.functions, ['A', 'B'])
    || !Array.isArray(input.functions.A) || !Array.isArray(input.functions.B)) {
    return [{ message: '程序文件格式不正确，需要主程序和动作组合 A、B。' }];
  }
  const allowEmpty = options.allowEmpty || options.draft;
  if (!allowEmpty && input.main.length === 0) add('先放一块指令积木，再让机器人出发吧。');
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  let count = 0;
  let structuralError = false;
  const references: { id: string; fn: 'A' | 'B'; owner: 'main' | 'A' | 'B' }[] = [];
  const walk = (nodes: unknown[], loopDepth: number, depth: number, owner: 'main' | 'A' | 'B'): void => {
    if (depth > MAX_STRUCTURE_DEPTH) { add('积木结构太深了，请把程序拆成较小的动作组合。'); structuralError = true; return; }
    for (const node of nodes) {
      count++;
      if (count > MAX_PROGRAM_NODES) { if (count === MAX_PROGRAM_NODES + 1) add('积木太多啦，每个程序最多可以放 200 块。'); structuralError = true; return; }
      if (!record(node) || seen.has(node)) { add('有一块积木的格式不正确，请重新添加。'); structuralError = true; continue; }
      seen.add(node);
      const id = typeof node.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(node.id) ? node.id : undefined;
      if (!id) { add('每块积木都需要一个有效的独立编号。'); structuralError = true; }
      else if (ids.has(id)) { add('发现重复的积木编号，请重新导出或复制积木。', id); structuralError = true; }
      else ids.add(id);
      const type = node.type;
      if (typeof type !== 'string' || !TYPES.has(type)) { add('这块积木的指令类型还不支持。', id); structuralError = true; continue; }
      if (!level.allowed.includes(type as Instruction['type'])) add('这一关还不能使用这块指令，试试已经学过的积木。', id);
      const keys = type === 'forward' || type === 'backward' ? ['id', 'type', 'steps']
        : type === 'repeat' ? ['id', 'type', 'times', 'body'] : type === 'call' ? ['id', 'type', 'fn'] : ['id', 'type'];
      if (!exactKeys(node, keys)) { add('积木含有缺失或不支持的字段，请使用平台导出的程序。', id); structuralError = true; }
      if (type === 'forward' || type === 'backward') {
        if (!Number.isInteger(node.steps) || (node.steps as number) < 1 || (node.steps as number) > 9) { add('前进和后退的步数要选 1 到 9。', id); structuralError = true; }
      } else if (type === 'repeat') {
        if (!Number.isInteger(node.times) || (node.times as number) < 2 || (node.times as number) > 9) { add('重复次数要选 2 到 9。', id); structuralError = true; }
        if (loopDepth >= MAX_LOOP_DEPTH) { add('重复积木最多套两层，试试把路线分成动作组合。', id); structuralError = true; }
        if (!Array.isArray(node.body)) { add('重复积木需要一个装指令的容器。', id); structuralError = true; }
        else {
          if (!allowEmpty && node.body.length === 0) add('重复积木里面还是空的，放入要重复的动作吧。', id);
          if (loopDepth < MAX_LOOP_DEPTH) walk(node.body, loopDepth + 1, depth + 1, owner);
        }
      } else if (type === 'call') {
        if (node.fn !== 'A' && node.fn !== 'B') { add('动作组合只能选择 A 或 B。', id); structuralError = true; }
        else if (id) references.push({ id, fn: node.fn, owner });
      }
    }
  };
  walk(input.main, 0, 0, 'main');
  walk(input.functions.A, 0, 0, 'A');
  walk(input.functions.B, 0, 0, 'B');
  if (typeof level.maxBlocks === 'number' && count > level.maxBlocks) add(`这一关最多使用 ${level.maxBlocks} 块积木，现在有 ${count} 块，试试让程序更简洁。`);
  if (!structuralError && !options.draft) {
    const bodies = input.functions;
    for (const ref of references) if ((bodies[ref.fn] as unknown[]).length === 0) add(`动作组合 ${ref.fn} 还没有定义，先在它的区域里放入积木。`, ref.id);
    const graph = { A: references.filter(ref => ref.owner === 'A'), B: references.filter(ref => ref.owner === 'B') };
    for (const owner of ['A', 'B'] as const) {
      const reaches = (fn: 'A' | 'B', target: 'A' | 'B', visited: Set<string>): boolean => {
        if (fn === target) return true;
        if (visited.has(fn)) return false;
        visited.add(fn);
        return graph[fn].some(ref => reaches(ref.fn, target, visited));
      };
      for (const ref of graph[owner]) if (reaches(ref.fn, owner, new Set())) add('动作组合不能绕回去调用自己，把相互调用的积木移开吧。', ref.id);
    }
  }
  return issues;
}

/** Count stored blocks once, including both definition areas, without expanding calls. */
export function countBlocks(program: Program): number {
  const count = (nodes: Instruction[]): number => nodes.reduce((sum, node) => sum + 1 + (node.type === 'repeat' ? count(node.body) : 0), 0);
  return count(program.main) + count(program.functions.A) + count(program.functions.B);
}
