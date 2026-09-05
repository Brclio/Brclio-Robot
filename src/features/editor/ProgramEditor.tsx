import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DragDropProvider, useDraggable, useDroppable } from '@dnd-kit/react';
import { Feedback, KeyboardSensor, PointerSensor, PointerActivationConstraints } from '@dnd-kit/dom';
import type { ExecutionContext, FunctionId, Instruction, InstructionType, Level, Program } from '../../types';
import { MAX_PROGRAM_NODES } from '../../engine/validation';
import { canInsert, cloneInstruction, containers, countNodes, createInstruction, getNodes, insertNode, locate, moveNode, removeNode, shiftNode, updateNode, type ContainerId } from './tree';
import './editor.css';

export interface ProgramEditorProps {
  program: Program; onChange: (program: Program) => void; level: Level; locked: boolean;
  active?: ExecutionContext; errorBlockId?: string; onNotice: (message: string) => void;
}
const names: Record<InstructionType, string> = { forward: '前进', backward: '后退', left: '左转', right: '右转', repeat: '重复', call: '执行' };
type PaletteItem = { type: InstructionType; fn?: FunctionId };
type Target = { container: ContainerId; index: number };
const sensors = [PointerSensor.configure({ activationConstraints: event => event.pointerType === 'touch'
  ? [new PointerActivationConstraints.Delay({ value: 180, tolerance: 8 })]
  : [new PointerActivationConstraints.Distance({ value: 6 })] }), KeyboardSensor];

export function BlockIcon({ type, fn, size = 28 }: { type: InstructionType | 'grip' | 'plus' | 'undo' | 'redo' | 'trash' | 'copy'; fn?: FunctionId; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type === 'forward' && <><path d="M16 26V6m-7 7 7-7 7 7" /><path d="M10 27h12" opacity=".4" /></>}
    {type === 'backward' && <><path d="M16 6v20m-7-7 7 7 7-7" /><path d="M10 5h12" opacity=".4" /></>}
    {type === 'left' && <path d="M25 26v-9a7 7 0 0 0-7-7H6m6-6-6 6 6 6" />}
    {type === 'right' && <path d="M7 26v-9a7 7 0 0 1 7-7h12m-6-6 6 6-6 6" />}
    {type === 'repeat' && <><path d="M6 13a11 11 0 0 1 19-5l2 3m0-7v7h-7M26 19A11 11 0 0 1 7 24l-2-3m0 7v-7h7" /></>}
    {type === 'call' && <><rect x="4" y="4" width="24" height="24" rx="8" /><text x="16" y="22" textAnchor="middle" fill="currentColor" stroke="none" fontSize="18" fontFamily="inherit" fontWeight="800">{fn}</text></>}
    {type === 'grip' && <>{[10, 21].map(x => [8, 16, 24].map(y => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" fill="currentColor" stroke="none" />))}</>}
    {type === 'plus' && <path d="M16 7v18M7 16h18" />}
    {type === 'undo' && <path d="M11 8 5 14l6 6M5 14h14a8 8 0 0 1 7 12" />}
    {type === 'redo' && <path d="m21 8 6 6-6 6m6-6H13a8 8 0 0 0-7 12" />}
    {type === 'trash' && <><path d="M7 10h18M13 6h6M9 10l1 17h12l1-17M14 15v7m4-7v7" /></>}
    {type === 'copy' && <><rect x="10" y="10" width="16" height="17" rx="3" /><path d="M20 6H8a3 3 0 0 0-3 3v13" /></>}
  </svg>;
}
function LibraryBlock({ item, locked, add }: { item: PaletteItem; locked: boolean; add: (item: PaletteItem) => void }) {
  const { ref, isDragging } = useDraggable({ id: `library-${item.type}${item.fn ? `-${item.fn}` : ''}`, disabled: locked, data: { kind: 'library', ...item } });
  const title = `${names[item.type]}${item.fn ? ` ${item.fn}` : ''}`;
  return <button ref={ref} disabled={locked} className={`library-block block-color-${item.type} ${isDragging ? 'is-dragging' : ''}`} onClick={() => add(item)} aria-label={`添加${title}`} data-testid={`library-${item.type}${item.fn ? `-${item.fn}` : ''}`}>
    <BlockIcon type={item.type} fn={item.fn} size={30} /><span>{title}</span>
    <span className="library-default">{item.type === 'forward' || item.type === 'backward' ? '1 格' : item.type === 'repeat' ? '2 次' : item.type === 'left' || item.type === 'right' ? '90°' : '组合'}</span>
  </button>;
}
function DropSlot({ container, index, locked, chosen, empty, dragging, onSelect, beforeId }: Target & { locked: boolean; chosen: boolean; empty?: boolean; dragging: boolean; beforeId?: string; onSelect: (target: Target) => void }) {
  // The end target keeps its identity when list length changes. A position number is
  // display data, not an entity ID: reusing it for a newly mounted gap can unregister
  // an existing drop target when a block is removed in the same React commit.
  const { ref, isDropTarget } = useDroppable({ id: beforeId ? `gap-${beforeId}` : `end-${container}`, disabled: locked, collisionPriority: 3, data: { container, index } });
  return <button ref={ref} disabled={locked} className={`insert-slot ${empty ? 'empty-slot' : ''} ${chosen ? 'chosen' : ''} ${isDropTarget ? 'drop-target' : ''} ${dragging ? 'drag-visible' : ''}`} data-testid={`insert-${container}-${index}`} aria-label={`${container === 'main' ? '主程序' : container.startsWith('fn:') ? `动作组合 ${container.slice(3)}` : '循环体'}第 ${index + 1} 个插入位置`} onClick={() => onSelect({ container, index })}>
    <BlockIcon type="plus" size={empty ? 32 : 20} />
    {empty && <><strong>把积木放到这里</strong><span>点击上面的积木，也可以拖进来</span></>}
    {!empty && <span className="insert-tooltip">插入这里</span>}
  </button>;
}
interface BoardProps {
  program: Program; container: ContainerId; nodes: Instruction[]; locked: boolean; selected: string | null;
  target: Target | null; dragging: boolean; active?: ExecutionContext; errorBlockId?: string; prefix?: string;
  select: (id: string) => void; selectTarget: (target: Target) => void;
  parameter: (id: string, value: number) => void; shift: (id: string, delta: -1 | 1) => void; remove: (id: string) => void;
}
function Sequence(props: BoardProps) {
  const { nodes, container, target, locked, dragging, selectTarget } = props;
  return <div className={`block-sequence ${!nodes.length ? 'sequence-empty' : ''}`} data-testid={`program-${container}`} role="group" aria-label={container === 'main' ? '主程序积木' : container.startsWith('fn:') ? `动作组合 ${container.slice(3)} 积木` : '循环体积木'}>
    {nodes.map((node, index) => <ProgramBlock key={node.id} {...props} node={node} index={index} />)}
    <DropSlot container={container} index={nodes.length} locked={locked} chosen={target?.container === container && target.index === nodes.length} empty={!nodes.length} dragging={dragging} onSelect={selectTarget} />
  </div>;
}
function ProgramBlock(props: BoardProps & { node: Instruction; index: number }) {
  const { node, index, container, locked, selected, active, errorBlockId, select, parameter, shift, remove, prefix = '', target, dragging, selectTarget } = props;
  const { ref, handleRef, isDragging } = useDraggable({ id: node.id, disabled: locked, data: { kind: 'block', blockId: node.id } });
  const { ref: dropRef, isDropTarget } = useDroppable({ id: `before-${node.id}`, disabled: locked, data: { container, index } });
  const isActive = active?.blockId === node.id;
  const isCall = active?.calls.some(call => call.blockId === node.id);
  const loop = active?.loops.find(loop => loop.blockId === node.id);
  const number = `${prefix}${index + 1}`;
  const keyDown = (event: KeyboardEvent) => {
    if (locked || event.target instanceof HTMLSelectElement) return;
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
      event.preventDefault(); event.stopPropagation(); shift(node.id, event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault(); event.stopPropagation(); remove(node.id);
    }
  };
  return <div ref={dropRef} className={`block-position ${node.type === 'repeat' ? 'repeat-position' : ''} ${isDropTarget ? 'insert-before' : ''}`}>
    <DropSlot container={container} index={index} beforeId={node.id} locked={locked} chosen={target?.container === container && target.index === index} dragging={dragging} onSelect={selectTarget} />
    <div ref={ref} data-testid={`block-${node.id}`} data-block-id={node.id} data-instruction={node.type} data-order={number} className={`program-block block-color-${node.type} ${selected === node.id ? 'selected' : ''} ${isActive ? 'executing' : ''} ${isCall || loop ? 'in-stack' : ''} ${errorBlockId === node.id ? 'block-error' : ''} ${isDragging ? 'is-dragging' : ''}`} onKeyDown={keyDown}>
      <div className="block-face">
        <span className="block-number">{number}</span>
        <button ref={handleRef} disabled={locked} className="drag-handle" aria-label={`拖动第 ${number} 块${names[node.type]}`} title="拖动积木；也可用下方按钮调整顺序" onClick={() => select(node.id)}><BlockIcon type="grip" size={22} /></button>
        <button disabled={locked} className="block-select" aria-label={`选择第 ${number} 块${names[node.type]}${node.type === 'call' ? ` ${node.fn}` : ''}`} aria-pressed={selected === node.id} onClick={() => select(node.id)}>
          <BlockIcon type={node.type} fn={node.type === 'call' ? node.fn : undefined} /><strong>{names[node.type]}{node.type === 'call' ? ` ${node.fn}` : ''}</strong>
        </button>
        {(node.type === 'forward' || node.type === 'backward' || node.type === 'repeat') && <label className="block-parameter">
          <select disabled={locked} aria-label={`第 ${number} 块${node.type === 'repeat' ? '重复次数' : '移动步数'}`} value={node.type === 'repeat' ? node.times : node.steps} onChange={event => parameter(node.id, Number(event.target.value))}>
            {Array.from({ length: node.type === 'repeat' ? 8 : 9 }, (_, i) => i + (node.type === 'repeat' ? 2 : 1)).map(value => <option key={value} value={value}>{value}</option>)}
          </select><span>{node.type === 'repeat' ? '次' : '格'}</span>
        </label>}
      </div>
      {isActive && active?.step && <div className="block-progress">第 {active.step.current}/{active.step.total} 步</div>}
      {loop && <div className="block-progress">第 {loop.current}/{loop.total} 轮</div>}
      {isCall && <div className="block-progress">正在执行组合 {node.type === 'call' ? node.fn : ''}</div>}
      {errorBlockId === node.id && <div className="block-progress error-progress">检查这块积木</div>}
      {node.type === 'repeat' && <div className="loop-body"><div className="loop-body-label">重复做这些动作 ↓</div><Sequence {...props} container={`repeat:${node.id}`} nodes={node.body} prefix={`${number}.`} /></div>}
    </div>
  </div>;
}

export function ProgramEditor({ program, onChange, level, locked, active, errorBlockId, onNotice }: ProgramEditorProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [history, setHistory] = useState<{ past: Program[]; future: Program[] }>({ past: [], future: [] });
  const [dragging, setDragging] = useState(false);
  const [moveTo, setMoveTo] = useState<ContainerId>('main');
  const expectedProgram = useRef(program);
  useEffect(() => {
    if (expectedProgram.current !== program) {
      setHistory({ past: [], future: [] }); setSelected(null); setTarget(null);
    }
    expectedProgram.current = program;
  }, [program]);
  const apply = (next: Program) => {
    if (locked || next === program) return;
    if (countNodes(next) > MAX_PROGRAM_NODES) { onNotice(`积木太多啦，一份程序最多放 ${MAX_PROGRAM_NODES} 块。试试用循环整理一下。`); return; }
    setHistory(current => ({ past: [...current.past.slice(-49), program], future: [] }));
    expectedProgram.current = next; onChange(next);
  };
  const undo = () => {
    if (locked || !history.past.length) return;
    const previous = history.past[history.past.length - 1];
    setHistory({ past: history.past.slice(0, -1), future: [program, ...history.future] });
    expectedProgram.current = previous; onChange(previous); setSelected(null); setTarget(null);
  };
  const redo = () => {
    if (locked || !history.future.length) return;
    const next = history.future[0];
    setHistory({ past: [...history.past, program], future: history.future.slice(1) });
    expectedProgram.current = next; onChange(next); setSelected(null); setTarget(null);
  };
  const select = (id: string) => { if (!locked) { setSelected(id); setTarget(null); } };
  const selectTarget = (next: Target) => { if (!locked) { setTarget(next); setSelected(null); } };
  const selection = selected ? locate(program, selected) : undefined;
  const insertAt = (): Target => {
    if (target && getNodes(program, target.container)) return target;
    if (selection) return { container: selection.container, index: selection.index + 1 };
    return { container: 'main', index: program.main.length };
  };
  const add = (item: PaletteItem, destination = insertAt()) => {
    if (locked) return;
    const node = createInstruction(item.type, item.fn);
    if (!canInsert(program, node, destination.container)) { onNotice('循环最多套两层。把这块积木放到外面的循环或主程序里吧。'); return; }
    apply(insertNode(program, node, destination.container, destination.index));
    setSelected(node.id); setTarget(null);
  };
  const remove = (id: string) => { apply(removeNode(program, id)); setSelected(null); setTarget(null); };
  const shift = (id: string, delta: -1 | 1) => { apply(shiftNode(program, id, delta)); setSelected(id); setTarget(null); };
  const parameter = (id: string, value: number) => apply(updateNode(program, id, node => node.type === 'repeat' ? { ...node, times: value } : node.type === 'forward' || node.type === 'backward' ? { ...node, steps: value } : node));
  const duplicate = () => {
    if (!selection || locked) return;
    const copy = cloneInstruction(selection.node);
    apply(insertNode(program, copy, selection.container, selection.index + 1)); setSelected(copy.id); setTarget(null);
  };
  const move = (id: string, destination: Target) => {
    const found = locate(program, id);
    if (locked || !found) return;
    if (!canInsert(program, found.node, destination.container)) { onNotice('不能把循环放进自己里面，也不能超过两层循环。换一个位置试试。'); return; }
    apply(moveNode(program, id, destination.container, destination.index)); setSelected(id); setTarget(null);
  };
  const palette: PaletteItem[] = level.allowed.flatMap<PaletteItem>(type => type === 'call' ? [{ type, fn: 'A' }, { type, fn: 'B' }] : [{ type }]);
  const destinations = containers(program).filter(container => (!container.id.startsWith('fn:') || level.allowed.includes('call')) && (!selection || canInsert(program, selection.node, container.id)));
  const validMoveTo = destinations.some(container => container.id === moveTo) ? moveTo : destinations[0]?.id ?? 'main';
  const total = countNodes(program);
  const sequenceProps = { program, locked, selected, target, dragging, active, errorBlockId, select, selectTarget, parameter, shift, remove };
  const keyboard = (event: KeyboardEvent) => {
    if (locked || event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && selected) { event.preventDefault(); duplicate(); }
    if (event.key === 'Escape') { setSelected(null); setTarget(null); }
  };
  return <DragDropProvider sensors={sensors} plugins={defaults => [...defaults.filter(plugin => plugin !== Feedback), Feedback.configure({ dropAnimation: null })]} onDragStart={() => setDragging(true)} onDragEnd={event => {
    setDragging(false);
    if (locked || event.canceled) return;
    const { source, target: drop } = event.operation;
    if (!source || !drop) return;
    const destination = drop.data as unknown as Target;
    if (!destination.container || !Number.isInteger(destination.index)) return;
    if (source.data.kind === 'library') add(source.data as unknown as PaletteItem, destination);
    else if (source.data.kind === 'block') move(String(source.data.blockId), destination);
  }}>
    <section className={`program-editor ${locked ? 'editor-locked' : ''} ${dragging ? 'editor-dragging' : ''}`} aria-label="积木编程工作区" onKeyDown={keyboard}>
      <div className="library-heading"><h2>指令积木</h2><span>点一点，或拖到下面</span></div>
      <div className="block-library" role="group" aria-label="指令积木库">{palette.map(item => <LibraryBlock key={`${item.type}-${item.fn ?? ''}`} item={item} locked={locked} add={add} />)}</div>
      <div className="program-heading"><div><h2>我的程序 <span className="program-count">{total}{level.maxBlocks ? ` / ${level.maxBlocks}` : ''} 块</span></h2><p>从左到右，一行接一行</p></div><div className="history-actions">
        <button disabled={locked || !history.past.length} onClick={undo} aria-label="撤销" title="撤销 Ctrl / ⌘ Z"><BlockIcon type="undo" size={22} /></button>
        <button disabled={locked || !history.future.length} onClick={redo} aria-label="重做" title="重做 Ctrl / ⌘ Shift Z"><BlockIcon type="redo" size={22} /></button>
        <button disabled={locked || total === 0} onClick={() => { if (window.confirm('清空主程序和动作组合中的所有积木？清空后还可以撤销。')) { apply({ main: [], functions: { A: [], B: [] } }); setSelected(null); setTarget(null); } }} aria-label="清空程序" title="清空程序"><BlockIcon type="trash" size={22} /></button>
      </div></div>
      <div className="main-program-board"><div className="sequence-heading"><span className="start-dot" />从这里开始 <span>主程序</span></div><Sequence {...sequenceProps} container="main" nodes={program.main} /></div>
      {locked ? <div className="editor-lock-note" role="status">程序正在执行中，想修改积木时先点「重置」。</div> : <div className={`selection-toolbar ${selection ? 'has-selection' : ''}`} aria-label="积木编辑工具">
        {selection ? <><span className="selection-caption">已选：{names[selection.node.type]}{selection.node.type === 'call' ? ` ${selection.node.fn}` : ''}</span><div className="selection-buttons">
          <button onClick={() => shift(selection.node.id, -1)} disabled={selection.index === 0} aria-label="前移积木">← 前移</button>
          <button onClick={() => shift(selection.node.id, 1)} disabled={selection.index === getNodes(program, selection.container)!.length - 1} aria-label="后移积木">后移 →</button>
          <button onClick={duplicate} aria-label="复制积木"><BlockIcon type="copy" size={18} />复制</button>
          <button onClick={() => remove(selection.node.id)} className="delete-button" aria-label="删除积木"><BlockIcon type="trash" size={18} />删除</button>
        </div>{level.allowed.includes('repeat') || level.allowed.includes('call') ? <div className="move-controls"><label htmlFor="move-destination">移到</label><select id="move-destination" aria-label="积木移动目标" value={validMoveTo} onChange={event => setMoveTo(event.target.value as ContainerId)}>{destinations.map(container => <option key={container.id} value={container.id}>{container.label}</option>)}</select><button onClick={() => move(selection.node.id, { container: validMoveTo, index: getNodes(program, validMoveTo)?.length ?? 0 })} aria-label="移动到目标区域">移动</button></div> : null}</>
        : <span>{target ? '位置选好啦，点击上方积木就能插入。' : '点选一块积木，可以移动、复制或删除。'}</span>}
      </div>}
      {level.allowed.includes('call') && <div className="function-definitions"><div className="function-title"><h3>动作组合</h3><span>先定义，放入「执行 A / B」才会运行</span></div>{(['A', 'B'] as const).map(fn => <section key={fn} className={`function-board ${active?.calls.some(call => call.fn === fn) ? 'function-active' : ''}`} aria-label={`动作组合 ${fn} 定义`}><div className="function-heading"><span className="function-letter">{fn}</span><strong>动作组合 {fn}</strong><button disabled={locked} onClick={() => selectTarget({ container: `fn:${fn}`, index: program.functions[fn].length })} aria-label={`向动作组合 ${fn} 添加积木`}>往这里放 +</button></div><Sequence {...sequenceProps} container={`fn:${fn}`} nodes={program.functions[fn]} prefix={`${fn}.`} /></section>)}</div>}
      <p className="editor-keyboard-tip">键盘也能玩：选中积木后，Alt + 方向键移动，Delete 删除。</p>
    </section>
  </DragDropProvider>;
}
