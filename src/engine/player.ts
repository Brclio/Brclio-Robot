import type { Level, PlayerSnapshot, Program, Settings } from '../types';
import { createInitialState, Interpreter } from './interpreter';

/** Serial presentation scheduler; all map semantics live in Interpreter. */
export class Player {
  private level: Level;
  private readonly onChange: (snapshot: PlayerSnapshot) => void;
  private snapshot: PlayerSnapshot;
  private interpreter?: Interpreter;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;
  private speed: Settings['speed'] = 1;

  constructor(level: Level, onChange: (snapshot: PlayerSnapshot) => void) {
    this.level = level;
    this.onChange = onChange;
    this.snapshot = { status: 'idle', runtime: createInitialState(level) };
  }

  getSnapshot(): PlayerSnapshot { return structuredClone(this.snapshot); }
  private emit(): void { if (!this.disposed) this.onChange(this.getSnapshot()); }
  private canSchedule(): boolean { return this.snapshot.status === 'running' || this.snapshot.status === 'pausing'; }
  private cancel(): void { this.generation++; if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }

  private advance(): void {
    if (this.disposed || !this.interpreter || this.snapshot.status !== 'running') return;
    this.snapshot.runtime = this.interpreter.step();
    if (this.snapshot.runtime.status === 'completed' || this.snapshot.runtime.status === 'error') this.snapshot.status = 'finished';
    const generation = this.generation;
    this.emit();
    // Subscribers may reset or switch levels during notification.
    if (this.disposed || generation !== this.generation || !this.canSchedule()) return;
    this.timer = setTimeout(() => {
      if (this.disposed || generation !== this.generation) return;
      this.timer = undefined;
      if (this.snapshot.status === 'pausing') { this.snapshot.status = 'paused'; this.emit(); }
      else this.advance();
    }, 600 / this.speed);
  }

  run(program: Program): void {
    if (this.disposed || ['running', 'pausing', 'paused'].includes(this.snapshot.status)) return;
    this.cancel();
    this.interpreter = new Interpreter(this.level, program);
    this.snapshot = { status: 'running', runtime: this.interpreter.getState() };
    this.advance();
  }

  step(program: Program): void {
    if (this.disposed || this.snapshot.status === 'running' || this.snapshot.status === 'pausing') return;
    this.cancel();
    if (!this.interpreter || this.snapshot.status === 'idle' || this.snapshot.status === 'finished') this.interpreter = new Interpreter(this.level, program);
    const runtime = this.interpreter.step();
    this.snapshot = { status: runtime.status === 'completed' || runtime.status === 'error' ? 'finished' : 'paused', runtime };
    this.emit();
  }

  pause(): void {
    if (this.disposed || this.snapshot.status !== 'running') return;
    this.snapshot.status = 'pausing';
    this.emit();
  }

  resume(): void {
    if (this.disposed || this.snapshot.status !== 'paused' || !this.interpreter) return;
    this.snapshot.status = 'running';
    this.advance();
  }

  reset(): void {
    if (this.disposed) return;
    this.cancel();
    this.interpreter = undefined;
    this.snapshot = { status: 'idle', runtime: createInitialState(this.level) };
    this.emit();
  }

  setLevel(level: Level): void { if (!this.disposed) { this.level = level; this.reset(); } }
  setSpeed(speed: Settings['speed']): void { if (speed === 0.5 || speed === 1 || speed === 2) this.speed = speed; }
  /** Motion is rendered by React/CSS; accessibility never changes execution cadence. */
  setReducedMotion(_reduced: boolean): void { /* The view consumes this setting. */ }
  dispose(): void { this.cancel(); this.disposed = true; this.interpreter = undefined; }
}
