let context: AudioContext | undefined;

// A single quiet, short tone with a soft attack and quick fade, synthesised so no audio asset has to ship.
export function playDoneSound() {
  try {
    context ||= new AudioContext();
    const audio = context;
    if (audio.state === 'suspended') void audio.resume();
    const at = audio.currentTime + 0.02;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.4);
  } catch {
    // Audio is a nicety; a blocked or missing audio device must not affect the app.
  }
}
