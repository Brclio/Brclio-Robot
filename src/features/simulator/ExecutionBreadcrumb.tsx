import type { ExecutionContext, Instruction, Program } from '../../types';
const names = { forward: '前进', backward: '后退', left: '左转', right: '右转', repeat: '重复', call: '执行' };
function location(program: Program, id: string): string {
  const walk = (nodes: Instruction[], area: string, prefix = ''): string | undefined => {
    for (const [index, node] of nodes.entries()) {
      const number = `${prefix}${index + 1}`;
      if (node.id === id) return `${area}第 ${number} 块 · ${names[node.type]}${node.type === 'call' ? node.fn : ''}`;
      if (node.type === 'repeat') { const result = walk(node.body, area, `${number}.`); if (result) return result; }
    }
  };
  return walk(program.main, '主程序') ?? walk(program.functions.A, 'A 中') ?? walk(program.functions.B, 'B 中') ?? '当前积木';
}
export function ExecutionBreadcrumb({ program, active }: { program: Program; active?: ExecutionContext }) {
  if (!active?.calls.length) return null;
  return <p className="call-progress" data-testid="execution-breadcrumb">{[...active.calls.map(call => location(program, call.blockId)), location(program, active.blockId)].join(' → ')}</p>;
}
