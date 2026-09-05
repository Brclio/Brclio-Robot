import { describe, expect, it } from 'vitest';
import { getLevel, levels } from '../data/levels';
import { Interpreter } from '../engine/interpreter';
import { countBlocks, validateProgram } from '../engine/validation';

describe('original teaching levels', () => {
  it('contains twelve challenge lessons and one free playground with staged commands', () => {
    expect(levels.filter(level => level.mode === 'challenge')).toHaveLength(12);
    expect(levels.filter(level => level.mode === 'free')).toHaveLength(1);
    expect(new Set(levels.map(level => level.id)).size).toBe(levels.length);
    for (const level of levels.slice(0, 3)) expect(level.allowed).toEqual(['forward']);
    for (const level of levels.slice(0, 6)) expect(level.allowed).not.toContain('repeat');
    for (const level of levels.slice(6, 9)) {
      expect(level.allowed).toContain('repeat');
      expect(level.allowed).not.toContain('call');
    }
    for (const level of levels.slice(9, 12)) expect(level.allowed).toContain('call');
    expect(getLevel('free').mode).toBe('free');
    expect(getLevel('nonexistent')).toBe(levels[0]);
  });

  for (const level of levels) {
    it(`${level.id} ${level.title}: validates map and completes its reference with the shared interpreter`, () => {
      const original = JSON.stringify(level);
      expect(level.width).toBeGreaterThanOrEqual(4);
      expect(level.width).toBeLessThanOrEqual(12);
      expect(level.height).toBeGreaterThanOrEqual(4);
      expect(level.height).toBeLessThanOrEqual(12);
      expect(level.hints).toHaveLength(3);
      expect(level.story.length).toBeGreaterThan(10);
      expect(level.objective.length).toBeGreaterThan(10);
      const walls = new Set(level.obstacles.map(p => `${p.x},${p.y}`));
      expect(walls.size).toBe(level.obstacles.length);
      expect(new Set(level.stars.map(s => s.id)).size).toBe(level.stars.length);
      expect(new Set(level.stars.map(p => `${p.x},${p.y}`)).size).toBe(level.stars.length);
      for (const point of [level.start, ...level.stars, ...level.obstacles, ...(level.goal ? [level.goal] : [])]) {
        expect(Number.isInteger(point.x) && Number.isInteger(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThan(level.width);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThan(level.height);
      }
      for (const point of [level.start, ...level.stars, ...(level.goal ? [level.goal] : [])]) expect(walls.has(`${point.x},${point.y}`)).toBe(false);
      if (level.mode === 'challenge') {
        expect(level.goal).toBeDefined();
        expect(level.stars.length).toBeGreaterThan(0);
      } else expect(level.goal).toBeUndefined();

      expect(validateProgram(level.solution, level)).toEqual([]);
      if (level.maxBlocks) expect(countBlocks(level.solution)).toBeLessThanOrEqual(level.maxBlocks);
      const interpreter = new Interpreter(level, level.solution);
      let state = interpreter.getState();
      let steps = 0;
      while (state.status !== 'completed' && state.status !== 'error' && steps < 2001) {
        state = interpreter.step();
        steps++;
      }
      expect(state.status, state.message).toBe('completed');
      expect(state.outcome, state.message).toBe(level.mode === 'challenge' ? 'success' : 'free');
      expect(state.actions).toBeGreaterThan(0);
      expect(state.budgetUsed).toBeLessThanOrEqual(2000);
      if (level.mode === 'challenge') {
        expect({ x: state.robot.x, y: state.robot.y }).toEqual(level.goal);
        expect([...state.collected].sort()).toEqual(level.stars.map(star => star.id).sort());
      }
      expect(JSON.stringify(level)).toBe(original);
    });
  }
});
