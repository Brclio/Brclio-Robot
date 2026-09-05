import { useEffect, useRef, useState } from 'react';
import { Player, createInitialState } from '../../engine';
import type { Level, PlayerSnapshot, Program, Settings } from '../../types';
import { enableSound, playTone } from './sound';
export function usePlayer(level: Level, settings: Settings, onSuccess: (snapshot: PlayerSnapshot) => void) {
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>({ status: 'idle', runtime: createInitialState(level) });
  const [resetKey, setResetKey] = useState(0);
  const player = useRef<Player | null>(null);
  const latest = useRef({ settings, onSuccess });
  const feedback = useRef({ previousActions: 0, previousStars: 0, completed: false, onSuccess });
  latest.current = { settings, onSuccess };
  const startSession = () => {
    feedback.current = { previousActions: 0, previousStars: 0, completed: false, onSuccess: latest.current.onSuccess };
    setResetKey(k => k + 1);
  };
  useEffect(() => {
    feedback.current = { previousActions: 0, previousStars: 0, completed: false, onSuccess: latest.current.onSuccess };
    const instance = new Player(level, next => {
      setSnapshot(next);
      const session = feedback.current;
      if (next.status === 'idle') { session.completed = false; session.previousActions = 0; session.previousStars = 0; }
      if (latest.current.settings.sound && next.runtime.actions > session.previousActions) playTone(next.runtime.collected.length > session.previousStars ? 'star' : 'step');
      if (next.runtime.outcome === 'success' && !session.completed) {
        session.completed = true; session.onSuccess(next);
        if (latest.current.settings.sound) playTone('success');
      } else if (next.runtime.status === 'error' && next.runtime.actions >= session.previousActions && latest.current.settings.sound) playTone('error');
      session.previousActions = next.runtime.actions; session.previousStars = next.runtime.collected.length;
    });
    player.current = instance; instance.setSpeed(latest.current.settings.speed);
    setSnapshot(instance.getSnapshot()); setResetKey(k => k + 1);
    const stop = () => { instance.reset(); setResetKey(k => k + 1); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); instance.dispose(); if (player.current === instance) player.current = null; };
  }, [level]);
  useEffect(() => { player.current?.setSpeed(settings.speed); }, [settings.speed]);
  const reset = () => { player.current?.reset(); setResetKey(k => k + 1); };
  const run = (program: Program) => {
    const instance = player.current;
    if (!instance || ['running', 'pausing', 'paused'].includes(instance.getSnapshot().status)) return;
    if (latest.current.settings.sound) enableSound();
    startSession(); instance.run(program);
  };
  const step = (program: Program) => {
    const instance = player.current;
    if (!instance) return;
    const status = instance.getSnapshot().status;
    if (status === 'running' || status === 'pausing') return;
    if (latest.current.settings.sound) enableSound();
    if (status === 'idle' || status === 'finished') startSession();
    instance.step(program);
  };
  return { snapshot, resetKey, reset, run, step, pause: () => player.current?.pause(), resume: () => player.current?.resume() };
}
