// Synthesized UI sounds using Web Audio API

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function playTone(freq: number, duration: number, type: OscillatorType = 'sine', volume = 0.15, startTime = 0) {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime + startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime + startTime);
  osc.stop(ctx.currentTime + startTime + duration);
}

/** Short ascending boop — mic started */
export function soundRecordStart() {
  playTone(440, 0.08, 'sine', 0.12);
  playTone(587, 0.08, 'sine', 0.12, 0.07);
}

/** Short descending boop — mic stopped */
export function soundRecordStop() {
  playTone(587, 0.08, 'sine', 0.12);
  playTone(440, 0.08, 'sine', 0.12, 0.07);
}

/** Quick blip — sent successfully */
export function soundSendSuccess() {
  playTone(880, 0.06, 'sine', 0.1);
  playTone(1047, 0.08, 'sine', 0.1, 0.06);
}

/** Positive chime — response received */
export function soundResponseReceived() {
  playTone(523, 0.1, 'sine', 0.12);
  playTone(659, 0.1, 'sine', 0.12, 0.1);
  playTone(784, 0.15, 'sine', 0.12, 0.2);
}

/** Error tone — request failed */
export function soundError() {
  playTone(330, 0.15, 'square', 0.1);
  playTone(262, 0.25, 'square', 0.1, 0.15);
}

// --- Thinking loop ---
let thinkingInterval: ReturnType<typeof setInterval> | null = null;
let thinkingStep = 0;

/** Start quiet repeating doot-doot pattern while thinking */
export function startThinkingSound() {
  stopThinkingSound();
  thinkingStep = 0;
  playThinkingPattern();
  thinkingInterval = setInterval(playThinkingPattern, 2000);
}

function playThinkingPattern() {
  // doot-doot ... doot-doot-doot pattern, very quiet
  const vol = 0.04;
  const freq = 392; // G4
  playTone(freq, 0.06, 'sine', vol);
  playTone(freq, 0.06, 'sine', vol, 0.12);
  // Third note on alternating cycles
  if (thinkingStep % 2 === 1) {
    playTone(freq, 0.06, 'sine', vol, 0.24);
  }
  thinkingStep++;
}

/** Stop thinking sound */
export function stopThinkingSound() {
  if (thinkingInterval) {
    clearInterval(thinkingInterval);
    thinkingInterval = null;
  }
  thinkingStep = 0;
}
