import { emptyProgram, type Direction, type ExecutionContext, type Instruction, type Level, type Program, type RuntimeState } from '../types';
import { validateProgram } from './validation';

type Context = Pick<ExecutionContext, 'loops' | 'calls'>;
interface SequenceFrame { kind: 'sequence'; nodes: Instruction[]; index: number; context: Context }
interface LoopFrame { kind: 'loop'; node: Extract<Instruction, { type: 'repeat' }>; iteration: number; context: Context }
interface AtomicFrame { node: Exclude<Instruction, { type: 'repeat' | 'call' }>; progress: number; context: Context }
type Frame = SequenceFrame | LoopFrame;
const DIRECTIONS: Direction[] = ['N', 'E', 'S', 'W'];
const VECTORS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] } as const;

export function createInitialState(level: Level): RuntimeState {
  return { robot: { ...level.start }, collected: [], trail: [{ x: level.start.x, y: level.start.y }], actions: 0, budgetUsed: 0, status: 'ready', message: '准备好了，给机器人摆一条路线吧。' };
}

/** Pure, lazy interpreter. A step executes at most one grid move or quarter turn. */
export class Interpreter {
  private readonly level: Level;
  private readonly program: Program;
  private readonly budget: number;
  private state: RuntimeState;
  private readonly stack: Frame[] = [];
  private pending?: AtomicFrame;

  constructor(level: Level, program: Program, budget = 2000) {
    this.level = structuredClone(level);
    this.budget = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 2000;
    this.state = createInitialState(level);
    const issues = validateProgram(program, level);
    this.program = issues.length ? emptyProgram() : structuredClone(program);
    if (issues.length) {
      this.state.status = 'error';
      this.state.message = issues[0].message;
      if (issues[0].blockId) this.state.active = { blockId: issues[0].blockId, loops: [], calls: [] };
    } else this.stack.push({ kind: 'sequence', nodes: this.program.main, index: 0, context: { loops: [], calls: [] } });
  }

  getState(): RuntimeState { return structuredClone(this.state); }
  private hasError(): boolean { return this.state.status === 'error'; }

  private charge(context: ExecutionContext): boolean {
    if (this.state.budgetUsed >= this.budget) {
      this.state.status = 'error';
      this.state.message = `程序绕得太久啦，已经用完 ${this.budget} 次执行机会。减少重复次数或动作组合调用，再试试。`;
      this.state.active = context;
      return false;
    }
    this.state.budgetUsed++;
    return true;
  }

  /** Process only control frames until the next atomic action, never expand a loop. */
  private prepare(): void {
    while (!this.pending && this.stack.length && this.state.status !== 'error') {
      const frame = this.stack[this.stack.length - 1];
      if (frame.kind === 'loop') {
        if (frame.iteration >= frame.node.times) { this.stack.pop(); continue; }
        const loop = { blockId: frame.node.id, current: frame.iteration + 1, total: frame.node.times };
        const context = { ...frame.context, loops: [...frame.context.loops, loop] };
        if (!this.charge({ blockId: frame.node.id, ...context })) return;
        frame.iteration++;
        this.stack.push({ kind: 'sequence', nodes: frame.node.body, index: 0, context });
        continue;
      }
      if (frame.index >= frame.nodes.length) { this.stack.pop(); continue; }
      const node = frame.nodes[frame.index++];
      if (!this.charge({ blockId: node.id, ...frame.context })) return;
      if (node.type === 'repeat') this.stack.push({ kind: 'loop', node, iteration: 0, context: frame.context });
      else if (node.type === 'call') this.stack.push({ kind: 'sequence', nodes: this.program.functions[node.fn], index: 0,
        context: { ...frame.context, calls: [...frame.context.calls, { blockId: node.id, fn: node.fn }] } });
      else this.pending = { node, progress: 0, context: frame.context };
    }
    if (!this.pending && !this.stack.length && this.state.status !== 'error') this.finish();
  }

  private finish(): void {
    this.state.status = 'completed';
    if (this.level.mode === 'free') {
      this.state.outcome = 'free';
      this.state.message = '程序执行完成。再设计一条有趣的路线吧！';
      return;
    }
    const onGoal = this.level.goal && this.state.robot.x === this.level.goal.x && this.state.robot.y === this.level.goal.y;
    const missing = this.level.stars.length - this.state.collected.length;
    if (onGoal && missing === 0) {
      this.state.outcome = 'success';
      this.state.message = '挑战成功！机器人停在了旗子上，也收集了所有星星。';
    } else {
      this.state.outcome = 'incomplete';
      this.state.message = !onGoal ? `程序执行完了，机器人还没有停在旗子上。${missing > 0 ? `还有 ${missing} 颗星星没有收集。` : '检查一下最后停留的位置吧。'}`
        : `已经到达旗子啦，还有 ${missing} 颗星星没有收集，看看怎样把它们连进路线。`;
    }
  }

  step(): RuntimeState {
    if (this.state.status === 'completed' || this.state.status === 'error') return this.getState();
    this.state.status = 'active';
    this.prepare();
    const action = this.pending;
    if (!action || this.hasError()) return this.getState();
    const { node } = action;
    const context: ExecutionContext = { blockId: node.id, ...action.context,
      ...((node.type === 'forward' || node.type === 'backward') ? { step: { current: action.progress + 1, total: node.steps } } : {}) };
    this.state.active = context;
    if (!this.charge(context)) return this.getState();
    if (node.type === 'forward' || node.type === 'backward') {
      const [dx, dy] = VECTORS[this.state.robot.direction];
      const sign = node.type === 'forward' ? 1 : -1;
      const x = this.state.robot.x + dx * sign;
      const y = this.state.robot.y + dy * sign;
      if (x < 0 || y < 0 || x >= this.level.width || y >= this.level.height) {
        this.state.status = 'error';
        this.state.message = '机器人走到地图外面啦，检查一下前进或后退的步数。';
        return this.getState();
      }
      if (this.level.obstacles.some(point => point.x === x && point.y === y)) {
        this.state.status = 'error';
        this.state.message = node.type === 'forward' ? '前面有障碍物，试试先转个弯。' : '后面有障碍物，试试先转个弯。';
        return this.getState();
      }
      this.state.robot = { ...this.state.robot, x, y };
      this.state.trail.push({ x, y });
      for (const star of this.level.stars) if (star.x === x && star.y === y && !this.state.collected.includes(star.id)) this.state.collected.push(star.id);
    } else {
      const turn = node.type === 'right' ? 1 : 3;
      this.state.robot = { ...this.state.robot, direction: DIRECTIONS[(DIRECTIONS.indexOf(this.state.robot.direction) + turn) % 4] };
    }
    this.state.actions++;
    action.progress++;
    this.state.message = '机器人正在按照你的积木行动。';
    if ((node.type !== 'forward' && node.type !== 'backward') || action.progress >= node.steps) this.pending = undefined;
    this.prepare();
    return this.getState();
  }
}
