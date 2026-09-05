export type Direction = 'N' | 'E' | 'S' | 'W';
export type FunctionId = 'A' | 'B';
export type InstructionType = 'forward' | 'backward' | 'left' | 'right' | 'repeat' | 'call';
export type Instruction =
  | { id: string; type: 'forward' | 'backward'; steps: number }
  | { id: string; type: 'left' | 'right' }
  | { id: string; type: 'repeat'; times: number; body: Instruction[] }
  | { id: string; type: 'call'; fn: FunctionId };
export interface Program { main: Instruction[]; functions: Record<FunctionId, Instruction[]> }
export interface Point { x: number; y: number }
export interface Robot extends Point { direction: Direction }
export interface Star extends Point { id: string }
export interface Level {
  id: string; number: number; title: string; story: string; objective: string;
  width: number; height: number; start: Robot; goal?: Point; obstacles: Point[]; stars: Star[];
  allowed: InstructionType[]; maxBlocks?: number; hints: string[]; solution: Program;
  mode: 'challenge' | 'free'; chapter: string;
}
export interface ExecutionContext {
  blockId: string;
  step?: { current: number; total: number };
  loops: { blockId: string; current: number; total: number }[];
  calls: { blockId: string; fn: FunctionId }[];
}
export interface RuntimeState {
  robot: Robot; collected: string[]; trail: Point[]; actions: number; budgetUsed: number;
  status: 'ready' | 'active' | 'completed' | 'error';
  outcome?: 'success' | 'incomplete' | 'free'; message: string;
  active?: ExecutionContext;
}
export type PlayerStatus = 'idle' | 'running' | 'pausing' | 'paused' | 'finished';
export interface PlayerSnapshot { status: PlayerStatus; runtime: RuntimeState }
export interface Settings { sound: boolean; speed: 0.5 | 1 | 2; trail: boolean; reducedMotion: boolean }
export interface CompletionRecord { completedAt: string; blocks: number; actions: number }
export interface SaveData { version: 1; currentLevel: string; drafts: Record<string, Program>; completed: Record<string, CompletionRecord>; settings: Settings }
export interface EditorState { past: Program[]; present: Program; future: Program[]; selectedId: string | null }
export interface ProgramFile { version: 1; levelId: string; main: Instruction[]; functions: Record<FunctionId, Instruction[]> }
export interface ValidationIssue { message: string; blockId?: string }
export const emptyProgram = (): Program => ({ main: [], functions: { A: [], B: [] } });
