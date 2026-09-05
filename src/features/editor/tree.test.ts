import { describe, expect, it } from 'vitest';
import { emptyProgram, type Instruction, type Program } from '../../types';
import { canInsert, cloneInstruction, containers, countNodes, createInstruction, getNodes, insertNode, locate, moveNode, removeNode, shiftNode, updateNode } from './tree';

const forward = (id: string): Instruction => ({ id, type: 'forward', steps: 1 });
const loop = (id: string, body: Instruction[] = []): Instruction => ({ id, type: 'repeat', times: 2, body });
const programWith = (main: Instruction[]): Program => ({ ...emptyProgram(), main });

describe('structured block editing', () => {
  it('creates stable unique IDs and instruction-attached numeric defaults', () => {
    const a = createInstruction('forward'); const b = createInstruction('repeat');
    expect(a).toMatchObject({ type: 'forward', steps: 1 });
    expect(b).toMatchObject({ type: 'repeat', times: 2, body: [] });
    expect(a.id).not.toBe(b.id);
    expect(createInstruction('call', 'B')).toMatchObject({ type: 'call', fn: 'B' });
  });
  it('inserts into dense data arrays without changing the original program', () => {
    const original = programWith([forward('a'), forward('c')]);
    const next = insertNode(original, forward('b'), 'main', 1);
    expect(next.main.map(node => node.id)).toEqual(['a', 'b', 'c']);
    expect(original.main.map(node => node.id)).toEqual(['a', 'c']);
  });
  it('moves forward and backward with correct original insertion boundary semantics', () => {
    const original = programWith(['a', 'b', 'c', 'd'].map(forward));
    expect(moveNode(original, 'a', 'main', 3).main.map(node => node.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveNode(original, 'd', 'main', 1).main.map(node => node.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveNode(original, 'b', 'main', 2)).toBe(original);
  });
  it('supports non-drag one-position movement and bounds', () => {
    const original = programWith(['a', 'b', 'c'].map(forward));
    expect(shiftNode(original, 'b', -1).main.map(node => node.id)).toEqual(['b', 'a', 'c']);
    expect(shiftNode(original, 'b', 1).main.map(node => node.id)).toEqual(['a', 'c', 'b']);
    expect(shiftNode(original, 'a', -1)).toBe(original);
    expect(shiftNode(original, 'c', 1)).toBe(original);
  });
  it('moves instructions into a loop and back into the main program without cloning IDs', () => {
    const original = programWith([forward('a'), loop('r', [forward('b')])]);
    const inside = moveNode(original, 'a', 'repeat:r', 1);
    expect(inside.main.map(node => node.id)).toEqual(['r']);
    expect(getNodes(inside, 'repeat:r')?.map(node => node.id)).toEqual(['b', 'a']);
    const outside = moveNode(inside, 'b', 'main', 0);
    expect(outside.main.map(node => node.id)).toEqual(['b', 'r']);
    expect(getNodes(outside, 'repeat:r')?.map(node => node.id)).toEqual(['a']);
    expect(locate(outside, 'a')?.container).toBe('repeat:r');
  });
  it('moves between functions and the main sequence', () => {
    const original = programWith([forward('a')]);
    const toA = moveNode(original, 'a', 'fn:A', 0);
    const toB = moveNode(toA, 'a', 'fn:B', 0);
    expect(toB.functions.A).toEqual([]);
    expect(toB.functions.B.map(node => node.id)).toEqual(['a']);
    expect(toB.main).toEqual([]);
  });
  it('prevents ancestor-to-descendant moves and insertion into missing containers', () => {
    const original = programWith([loop('outer', [loop('inner')])]);
    expect(moveNode(original, 'outer', 'repeat:inner', 0)).toBe(original);
    expect(moveNode(original, 'outer', 'repeat:outer', 0)).toBe(original);
    expect(insertNode(original, forward('a'), 'repeat:missing', 0)).toBe(original);
  });
  it('allows two loop layers but prevents creating a third via insertion or subtree movement', () => {
    const original = programWith([loop('outer', [loop('inner')]), loop('other', [loop('child')])]);
    expect(canInsert(original, forward('a'), 'repeat:inner')).toBe(true);
    expect(canInsert(original, loop('third'), 'repeat:inner')).toBe(false);
    expect(moveNode(original, 'other', 'repeat:outer', 0)).toBe(original);
    const simple = programWith([loop('outer'), loop('other')]);
    expect(moveNode(simple, 'other', 'repeat:outer', 0)).not.toBe(simple);
  });
  it('clones a whole subtree with fresh IDs while retaining instruction semantics', () => {
    const original = loop('r', [forward('a'), loop('s', [{ id: 'b', type: 'right' }])]);
    const copied = cloneInstruction(original);
    const source = programWith([original]); const copy = programWith([copied]);
    expect(countNodes(copy)).toBe(4);
    expect(containers(copy).filter(c => c.id.startsWith('repeat:'))).toHaveLength(2);
    for (const id of ['r', 'a', 's', 'b']) expect(locate(copy, id)).toBeUndefined();
    expect(countNodes(source)).toBe(4);
    expect(copied).toMatchObject({ type: 'repeat', times: 2, body: [{ type: 'forward', steps: 1 }, { type: 'repeat', times: 2 }] });
  });
  it('updates and deletes nested nodes without mutating a reusable prior history snapshot', () => {
    const original = programWith([loop('r', [forward('a'), forward('b')])]);
    const edited = updateNode(original, 'a', node => ({ ...node, type: 'forward', steps: 9 }));
    expect(locate(edited, 'a')?.node).toMatchObject({ steps: 9 });
    expect(locate(original, 'a')?.node).toMatchObject({ steps: 1 });
    const removed = removeNode(edited, 'a');
    expect(getNodes(removed, 'repeat:r')?.map(node => node.id)).toEqual(['b']);
    expect(getNodes(original, 'repeat:r')).toHaveLength(2);
  });
});
