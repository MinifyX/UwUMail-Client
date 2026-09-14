/** A soft two-note "pling" for the finish, made on the spot instead of shipping a sound file. */
export function pling() {
  const context = new AudioContext();
  const now = context.currentTime;
  for (const [frequency, start] of [
    [880, 0],
    [1318.5, 0.12],
  ] as const) {
    const tone = context.createOscillator();
    const volume = context.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    volume.gain.setValueAtTime(0.0001, now + start);
    volume.gain.exponentialRampToValueAtTime(0.1, now + start + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.7);
    tone.connect(volume).connect(context.destination);
    tone.start(now + start);
    tone.stop(now + start + 0.75);
  }
  setTimeout(() => void context.close(), 1500);
}
