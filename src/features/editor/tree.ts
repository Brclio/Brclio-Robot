import type { FunctionId, Instruction, InstructionType, Program } from '../../types';

/** Containers are identified by data IDs, never by layout coordinates. */
export type ContainerId = 'main' | `fn:${FunctionId}` | `repeat:${string}`;
export interface Location { container: ContainerId; index: number; node: Instruction }
export const makeId = () => `block-${crypto.randomUUID()}`;
export function createInstruction(type: InstructionType, fn: FunctionId = 'A'): Instruction {
  const id = makeId();
  if (type === 'forward' || type === 'backward') return { id, type, steps: 1 };
  if (type === 'repeat') return { id, type, times: 2, body: [] };
  if (type === 'call') return { id, type, fn };
  return { id, type };
}
export function locate(program: Program, id: string): Location | undefined {
  const visit = (nodes: Instruction[], container: ContainerId): Location | undefined => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (node.id === id) return { node, index, container };
      if (node.type === 'repeat') {
        const found = visit(node.body, `repeat:${node.id}`);
        if (found) return found;
      }
    }
  };
  return visit(program.main, 'main') ?? visit(program.functions.A, 'fn:A') ?? visit(program.functions.B, 'fn:B');
}
export function getNodes(program: Program, container: ContainerId): Instruction[] | undefined {
  if (container === 'main') return program.main;
  if (container === 'fn:A') return program.functions.A;
  if (container === 'fn:B') return program.functions.B;
  const node = locate(program, container.slice(7))?.node;
  return node?.type === 'repeat' ? node.body : undefined;
}
function updateContainer(program: Program, container: ContainerId, update: (nodes: Instruction[]) => Instruction[]): Program {
  if (container === 'main') return { ...program, main: update(program.main) };
  if (container === 'fn:A' || container === 'fn:B') {
    const fn = container.slice(3) as FunctionId;
    return { ...program, functions: { ...program.functions, [fn]: update(program.functions[fn]) } };
  }
  return updateNode(program, container.slice(7), node => node.type === 'repeat' ? { ...node, body: update(node.body) } : node);
}
export function updateNode(program: Program, id: string, update: (node: Instruction) => Instruction): Program {
  const map = (nodes: Instruction[]): Instruction[] => nodes.map(node => node.id === id ? update(node) : node.type === 'repeat' ? { ...node, body: map(node.body) } : node);
  return { main: map(program.main), functions: { A: map(program.functions.A), B: map(program.functions.B) } };
}
export function removeNode(program: Program, id: string): Program {
  const location = locate(program, id);
  return location ? updateContainer(program, location.container, nodes => nodes.filter(node => node.id !== id)) : program;
}
function contains(node: Instruction, id: string): boolean {
  return node.id === id || (node.type === 'repeat' && node.body.some(child => contains(child, id)));
}
export function loopDepth(program: Program, container: ContainerId): number {
  if (!container.startsWith('repeat:')) return 0;
  const location = locate(program, container.slice(7));
  return location ? 1 + loopDepth(program, location.container) : 0;
}
function subtreeLoopDepth(node: Instruction): number {
  return node.type === 'repeat' ? 1 + Math.max(0, ...node.body.map(subtreeLoopDepth)) : 0;
}
export function canInsert(program: Program, node: Instruction, container: ContainerId): boolean {
  return getNodes(program, container) !== undefined &&
    !(container.startsWith('repeat:') && contains(node, container.slice(7))) &&
    loopDepth(program, container) + subtreeLoopDepth(node) <= 2;
}
export function insertNode(program: Program, node: Instruction, container: ContainerId, index: number): Program {
  if (!canInsert(program, node, container)) return program;
  return updateContainer(program, container, nodes => {
    const next = [...nodes];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, node);
    return next;
  });
}
/** index is the insertion boundary in the original destination list. */
export function moveNode(program: Program, id: string, container: ContainerId, index: number): Program {
  const location = locate(program, id);
  if (!location || !canInsert(program, location.node, container)) return program;
  const adjusted = location.container === container && location.index < index ? index - 1 : index;
  if (location.container === container && location.index === adjusted) return program;
  return insertNode(removeNode(program, id), location.node, container, adjusted);
}
export function shiftNode(program: Program, id: string, delta: -1 | 1): Program {
  const location = locate(program, id);
  if (!location) return program;
  const nodes = getNodes(program, location.container)!;
  if (location.index + delta < 0 || location.index + delta >= nodes.length) return program;
  return moveNode(program, id, location.container, location.index + (delta > 0 ? 2 : -1));
}
export function cloneInstruction(node: Instruction): Instruction {
  return node.type === 'repeat' ? { ...node, id: makeId(), body: node.body.map(cloneInstruction) } : { ...node, id: makeId() };
}
export function countNodes(program: Program): number {
  const count = (nodes: Instruction[]): number => nodes.reduce((total, node) => total + 1 + (node.type === 'repeat' ? count(node.body) : 0), 0);
  return count(program.main) + count(program.functions.A) + count(program.functions.B);
}
export function containers(program: Program): { id: ContainerId; label: string }[] {
  const result: { id: ContainerId; label: string }[] = [{ id: 'main', label: '主程序' }, { id: 'fn:A', label: '动作组合 A' }, { id: 'fn:B', label: '动作组合 B' }];
  const visit = (nodes: Instruction[], prefix: string) => nodes.forEach((node, index) => {
    if (node.type !== 'repeat') return;
    const label = `${prefix}${index + 1} 的循环体`;
    result.push({ id: `repeat:${node.id}`, label });
    visit(node.body, `${prefix}${index + 1}.`);
  });
  visit(program.main, '主程序 '); visit(program.functions.A, 'A '); visit(program.functions.B, 'B ');
  return result;
}
