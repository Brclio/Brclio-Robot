import { describe, expect, it } from 'vitest';
import { countBlocks, createInitialState, Interpreter, validateProgram } from '../engine';
import { emptyProgram, type Instruction, type Level, type Program, type RuntimeState } from '../types';

let nextId = 0;
const id = () => `test-${++nextId}`;
const forward = (steps = 1): Instruction => ({ id: id(), type: 'forward', steps });
const backward = (steps = 1): Instruction => ({ id: id(), type: 'backward', steps });
const right = (): Instruction => ({ id: id(), type: 'right' });
const left = (): Instruction => ({ id: id(), type: 'left' });
const repeat = (times: number, body: Instruction[]): Instruction => ({ id: id(), type: 'repeat', times, body });
const call = (fn: 'A' | 'B'): Instruction => ({ id: id(), type: 'call', fn });
const program = (main: Instruction[], A: Instruction[] = [], B: Instruction[] = []): Program => ({ main, functions: { A, B } });
const level = (overrides: Partial<Level> = {}): Level => ({ id: 'test', number: 0, title: '测试', story: '', objective: '',
  width: 5, height: 5, start: { x: 1, y: 1, direction: 'E' }, obstacles: [], stars: [],
  allowed: ['forward', 'backward', 'left', 'right', 'repeat', 'call'], hints: [], solution: emptyProgram(), mode: 'free', chapter: '', ...overrides });
const execute = (map: Level, code: Program, budget?: number): RuntimeState => {
  const engine = new Interpreter(map, code, budget);
  for (let n = 0; n <= 2001; n++) {
    const state = engine.step();
    if (state.status === 'completed' || state.status === 'error') return state;
  }
  throw new Error('Interpreter failed to terminate within safety budget');
};

describe('atomic movement and direction acceptance', () => {
  it('1. sequence ends at (2,1), east, from (1,3), north', () => {
    const result = execute(level({ start: { x: 1, y: 3, direction: 'N' } }), program([forward(2), right(), forward()]));
    expect(result.robot).toEqual({ x: 2, y: 1, direction: 'E' });
    expect(result.actions).toBe(4);
    expect(result.outcome).toBe('free');
  });
  it('2. repeat four [forward 2, right] returns home with exactly 12 actions', () => {
    const result = execute(level(), program([repeat(4, [forward(2), right()])]));
    expect(result.robot).toEqual({ x: 1, y: 1, direction: 'E' });
    expect(result.actions).toBe(12);
    expect(result.status).toBe('completed');
  });
  it('3. multi-cell movement stops before obstacle and does not run remaining blocks', () => {
    const move = forward(3);
    const result = execute(level({ obstacles: [{ x: 3, y: 1 }] }), program([move, right()]));
    expect(result.robot).toEqual({ x: 2, y: 1, direction: 'E' });
    expect(result.actions).toBe(1);
    expect(result.status).toBe('error');
    expect(result.message).toContain('障碍物');
    expect(result.active).toMatchObject({ blockId: move.id, step: { current: 2, total: 3 } });
  });
  it('4. backward moves south when facing north without turning', () => {
    expect(execute(level({ start: { x: 2, y: 2, direction: 'N' } }), program([backward()])).robot).toEqual({ x: 2, y: 3, direction: 'N' });
  });
  it('5. a function called four times returns to original position and direction', () => {
    const result = execute(level(), program([call('A'), call('A'), call('A'), call('A')], [forward(), right()]));
    expect(result.robot).toEqual({ x: 1, y: 1, direction: 'E' });
    expect(result.actions).toBe(8);
  });
  it('6. forward 3 needs three steps and finishes on the third without an extra click', () => {
    const engine = new Interpreter(level(), program([forward(3)]));
    const first = engine.step();
    expect(first).toMatchObject({ robot: { x: 2 }, status: 'active', actions: 1, active: { step: { current: 1, total: 3 } } });
    expect(engine.step()).toMatchObject({ robot: { x: 3 }, status: 'active', actions: 2, active: { step: { current: 2, total: 3 } } });
    expect(engine.step()).toMatchObject({ robot: { x: 4 }, status: 'completed', actions: 3, active: { step: { current: 3, total: 3 } } });
    expect(engine.step().actions).toBe(3);
  });
  it.each(['N', 'E', 'S', 'W'] as const)('four left or right turns preserve position facing %s', direction => {
    for (const turn of [left, right]) {
      expect(execute(level({ start: { x: 2, y: 2, direction } }), program([turn(), turn(), turn(), turn()])).robot).toEqual({ x: 2, y: 2, direction });
    }
  });
  it('checks every crossed cell for stars and collects a revisited star only once', () => {
    const map = level({ stars: [{ id: 'one', x: 2, y: 1 }, { id: 'two', x: 3, y: 1 }] });
    const original = structuredClone(map);
    const result = execute(map, program([forward(3), backward(3)]));
    expect(result.collected).toEqual(['one', 'two']);
    expect(result.trail).toHaveLength(7);
    expect(map).toEqual(original);
  });
  it.each([
    { x: 0, y: 0, direction: 'N' as const }, { x: 4, y: 0, direction: 'E' as const },
    { x: 0, y: 4, direction: 'S' as const }, { x: 0, y: 0, direction: 'W' as const },
  ])('cannot cross the boundary at $direction', start => {
    const result = execute(level({ start }), program([forward(), right()]));
    expect(result.robot).toEqual(start);
    expect(result.actions).toBe(0);
    expect(result.status).toBe('error');
    expect(result.message).toContain('地图外面');
  });
  it('backward collision does not change heading or position', () => {
    const result = execute(level({ obstacles: [{ x: 0, y: 1 }] }), program([backward()]));
    expect(result.robot).toEqual({ x: 1, y: 1, direction: 'E' });
    expect(result.message).toContain('后面有障碍物');
  });
});

describe('nested structures and execution feedback', () => {
  it('shows both function call sites and the instruction inside its loop', () => {
    const callA = call('A'); const callB = call('B'); const move = forward(2); const loop = repeat(2, [move, backward(2)]);
    const engine = new Interpreter(level(), program([callA], [callB], [loop]));
    expect(engine.step().active).toEqual({ blockId: move.id, step: { current: 1, total: 2 },
      calls: [{ blockId: callA.id, fn: 'A' }, { blockId: callB.id, fn: 'B' }], loops: [{ blockId: loop.id, current: 1, total: 2 }] });
    engine.step(); engine.step(); engine.step();
    expect(engine.step().active).toMatchObject({ blockId: move.id, loops: [{ blockId: loop.id, current: 2, total: 2 }] });
  });
  it('supports two nested loops with single stepping through both', () => {
    const inner = repeat(2, [right()]); const outer = repeat(2, [inner]);
    const engine = new Interpreter(level(), program([outer]));
    expect(engine.step().active?.loops).toHaveLength(2);
    engine.step(); engine.step();
    expect(engine.step()).toMatchObject({ actions: 4, status: 'completed', robot: { direction: 'E' } });
  });
  it('does not execute definition areas unless called', () => {
    expect(execute(level(), program([right()], [forward(9)], [backward(9)])).actions).toBe(1);
  });
  it('counts definitions once instead of expanding calls', () => {
    expect(countBlocks(program([call('A'), call('A')], [repeat(9, [right()])]))).toBe(4);
  });
  it('protects interpreter state and program from consumer mutation', () => {
    const map = level(); const code = program([forward(2)]); const engine = new Interpreter(map, code);
    const snapshot = engine.step(); snapshot.robot.x = 99; snapshot.collected.push('fake');
    code.main[0] = backward(9); map.start.x = 99;
    expect(engine.step()).toMatchObject({ robot: { x: 3, y: 1 }, collected: [], actions: 2 });
  });
});

describe('9. success is evaluated only after normal termination', () => {
  const map = () => level({ mode: 'challenge', goal: { x: 2, y: 1 } });
  it('succeeds on goal with every required star', () => {
    expect(execute(level({ mode: 'challenge', goal: { x: 4, y: 1 }, stars: [{ id: 's', x: 2, y: 1 }] }), program([forward(3)])).outcome).toBe('success');
  });
  it('cannot succeed when ending away from goal', () => { expect(execute(map(), program([right()])).outcome).toBe('incomplete'); });
  it('cannot succeed with a missing star', () => {
    const result = execute({ ...map(), stars: [{ id: 's', x: 0, y: 0 }] }, program([forward()]));
    expect(result.outcome).toBe('incomplete'); expect(result.message).toContain('1 颗星星');
  });
  it('passing the goal and leaving does not succeed', () => { expect(execute(map(), program([forward(2)])).outcome).toBe('incomplete'); });
  it('passing the goal then crashing does not succeed', () => {
    const result = execute(map(), program([forward(9)]));
    expect(result.status).toBe('error'); expect(result.outcome).toBeUndefined();
  });
  it('passing goal midway through a program does not stop execution', () => {
    const engine = new Interpreter(map(), program([forward(2)]));
    expect(engine.step()).toMatchObject({ robot: { x: 2 }, status: 'active' });
    expect(engine.getState().outcome).toBeUndefined();
  });
  it('free practice never reports challenge failure', () => {
    const result = execute(level(), program([right()]));
    expect(result.outcome).toBe('free'); expect(result.message).toContain('程序执行完成');
  });
  it('fresh runs restore stars, heading and position independently', () => {
    const map = level({ stars: [{ id: 's', x: 2, y: 1 }] }); const code = program([forward()]);
    execute(map, code);
    expect(createInitialState(map)).toMatchObject({ robot: map.start, actions: 0, collected: [], budgetUsed: 0 });
    expect(execute(map, code).collected).toEqual(['s']);
  });
});

describe('10. malformed programs and bounded interpretation', () => {
  it('rejects an empty program with an understandable message', () => {
    const result = execute(level(), emptyProgram());
    expect(result.status).toBe('error'); expect(result.message).toContain('先放一块');
  });
  it.each([0, -1, 10, 1.5, NaN, Infinity, '2'])('rejects invalid movement parameter %s', steps => {
    const invalid = program([{ id: id(), type: 'forward', steps } as Instruction]);
    expect(validateProgram(invalid, level())[0].message).toContain('1 到 9');
    expect(execute(level(), invalid).status).toBe('error');
  });
  it.each([0, 1, 10, 2.5, '2'])('rejects invalid loop parameter %s', times => {
    expect(validateProgram(program([{ id: id(), type: 'repeat', times, body: [right()] } as Instruction]), level())[0].message).toContain('2 到 9');
  });
  it('rejects empty loops even in uncalled definition areas before running', () => {
    expect(validateProgram(program([right()], [repeat(2, [])]), level())[0].message).toContain('还是空的');
  });
  it('rejects undefined function calls', () => {
    expect(execute(level(), program([call('A')])).message).toContain('还没有定义');
  });
  it('rejects direct recursion', () => {
    expect(execute(level(), program([call('A')], [call('A')])).message).toContain('调用自己');
  });
  it('rejects indirect recursion including unreachable functions', () => {
    expect(execute(level(), program([right()], [call('B')], [call('A')])).message).toContain('调用自己');
  });
  it('enforces the instruction whitelist even inside unused functions', () => {
    const map = level({ allowed: ['forward'] });
    expect(validateProgram(program([forward()], [right()]), map).some(issue => issue.message.includes('这一关还不能'))).toBe(true);
  });
  it('enforces level block limits over the whole stored program', () => {
    expect(validateProgram(program([forward()], [right()]), level({ maxBlocks: 1 })).some(issue => issue.message.includes('最多使用 1'))).toBe(true);
  });
  it('permits empty imported drafts but still rejects undefined functions and recursion', () => {
    expect(validateProgram(program([], [repeat(2, [])]), level(), { allowEmpty: true })).toEqual([]);
    expect(validateProgram(program([call('A')]), level(), { allowEmpty: true })).not.toEqual([]);
    expect(validateProgram(program([call('A')], [call('A')]), level(), { allowEmpty: true })).not.toEqual([]);
  });
  it('storage draft mode can restore unfinished references without making them runnable', () => {
    const code = program([call('A')]);
    expect(validateProgram(code, level(), { draft: true })).toEqual([]);
    expect(execute(level(), code).status).toBe('error');
  });
  it('stops at the unified budget without eagerly expanding very large nested calls', () => {
    const code = program([repeat(9, [repeat(9, [call('A')])])], [repeat(9, [repeat(9, [call('B')])])], [right()]);
    const result = execute(level(), code);
    expect(result.status).toBe('error'); expect(result.message).toContain('2000 次执行机会');
    expect(result.budgetUsed).toBe(2000); expect(result.actions).toBeLessThan(2000);
  });
  it('function calls and loop iterations consume budget, including before a movement', () => {
    const result = execute(level(), program([call('A')], [repeat(2, [forward()])]), 2);
    expect(result.status).toBe('error'); expect(result.actions).toBe(0); expect(result.budgetUsed).toBe(2);
  });
  it('can finish on an exact budget boundary', () => {
    const result = execute(level(), program([right()]), 2);
    expect(result.status).toBe('completed'); expect(result.budgetUsed).toBe(2);
    expect(execute(level(), program([right()]), 1).status).toBe('error');
  });
  it('budget failure after an action highlights the blocked next control, retaining the completed move', () => {
    const move = forward(); const invocation = call('A');
    const result = execute(level(), program([move, invocation], [right()]), 2);
    expect(result).toMatchObject({ status: 'error', actions: 1, robot: { x: 2, y: 1, direction: 'E' }, budgetUsed: 2 });
    expect(result.active?.blockId).toBe(invocation.id);
    expect(result.active?.blockId).not.toBe(move.id);
  });
  it('rejects more than two structurally nested loops', () => {
    expect(validateProgram(program([repeat(2, [repeat(2, [repeat(2, [right()])])])]), level()).some(issue => issue.message.includes('最多套两层'))).toBe(true);
  });
  it('rejects 201 nodes but accepts exactly 200', () => {
    expect(validateProgram(program(Array.from({ length: 200 }, right)), level())).toEqual([]);
    expect(validateProgram(program(Array.from({ length: 201 }, right)), level()).some(issue => issue.message.includes('200 块'))).toBe(true);
  });
  it('IDs must exist and be globally unique across functions and loops', () => {
    const node = right(); const duplicate = { ...node };
    expect(validateProgram(program([node], [repeat(2, [duplicate])]), level()).some(issue => issue.message.includes('重复的积木编号'))).toBe(true);
    expect(validateProgram(program([{ type: 'right' } as Instruction]), level()).some(issue => issue.message.includes('独立编号'))).toBe(true);
  });
  it.each([null, 1, [], {}, { main: [] }, { main: [], functions: [] }, { main: [], functions: { A: [], B: [], C: [] } }])('rejects malformed program shape %#', code => {
    expect(validateProgram(code, level()).length).toBeGreaterThan(0);
  });
  it.each([
    { id: 'x', type: 'execute', code: 'alert(1)' },
    { id: 'x', type: 'right', html: '<img src=x>' },
    { id: 'x', type: 'forward', steps: 1, url: 'https://example.com' },
    { id: 'x', type: 'repeat', times: 2, body: 'javascript' },
    { id: 'x', type: 'call', fn: 'C' },
  ])('rejects unrecognized commands and extra fields %#', node => {
    expect(validateProgram({ main: [node], functions: { A: [], B: [] } }, level()).length).toBeGreaterThan(0);
  });
  it('rejects prototype-sensitive fields and self-referential structures', () => {
    const dangerous = JSON.parse('{"main":[{"id":"x","type":"right","__proto__":{}}],"functions":{"A":[],"B":[]}}');
    expect(validateProgram(dangerous, level()).length).toBeGreaterThan(0);
    const cycle: Record<string, unknown> = { id: 'cycle', type: 'repeat', times: 2 }; cycle.body = [cycle];
    expect(validateProgram({ main: [cycle], functions: { A: [], B: [] } }, level()).length).toBeGreaterThan(0);
  });
  it('handles an invalid non-cloneable instruction without throwing', () => {
    const code = program([{ id: 'x', type: 'right', extra: () => undefined } as Instruction]);
    expect(() => new Interpreter(level(), code)).not.toThrow();
    expect(execute(level(), code).status).toBe('error');
  });
});

describe('supported grid dimensions', () => {
  it.each([[4, 4], [12, 12], [4, 12]])('uses the actual %s by %s map boundary', (width, height) => {
    const map = level({ width, height, start: { x: 0, y: height - 1, direction: 'E' } });
    const route = program(Array.from({ length: width - 1 }, () => forward()));
    expect(execute(map, route)).toMatchObject({ status: 'completed', robot: { x: width - 1, y: height - 1, direction: 'E' }, actions: width - 1 });
    const beyond = execute(map, program([...route.main, forward()]));
    expect(beyond.status).toBe('error');
    expect(beyond.robot).toEqual({ x: width - 1, y: height - 1, direction: 'E' });
    expect(beyond.message).toContain('地图外面');
  });
});
