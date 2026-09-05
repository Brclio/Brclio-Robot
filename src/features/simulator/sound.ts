let context: AudioContext | undefined;
export function enableSound() {
  try { context ??= new AudioContext(); void context.resume().catch(() => {}); } catch { /* Audio is optional; simulation always works. */ }
}
export function playTone(kind: 'step' | 'star' | 'success' | 'error') {
  try {
    if (!context || context.state !== 'running') return;
    const now = context.currentTime;
    const notes = kind === 'success' ? [523, 659, 784] : [kind === 'star' ? 880 : kind === 'error' ? 196 : 392];
    notes.forEach((frequency, index) => {
      const oscillator = context!.createOscillator(), gain = context!.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now + index * .12);
      gain.gain.linearRampToValueAtTime(.045, now + index * .12 + .01);
      gain.gain.exponentialRampToValueAtTime(.001, now + index * .12 + .12);
      oscillator.connect(gain); gain.connect(context!.destination);
      oscillator.start(now + index * .12); oscillator.stop(now + index * .12 + .14);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    });
  } catch { /* Unsupported audio must not interrupt programming. */ }
}
