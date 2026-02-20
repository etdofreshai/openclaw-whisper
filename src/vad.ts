// Voice Activity Detection using Web Audio API AnalyserNode

export interface VADOptions {
  /** RMS threshold above noise floor to trigger speech (default: 0.015) */
  threshold?: number;
  /** Silence duration (ms) before stopping recording (default: 1500) */
  silenceMs?: number;
  /** Minimum speech duration (ms) before we accept it (default: 300) */
  minSpeechMs?: number;
  /** Analysis interval (ms) (default: 50) */
  intervalMs?: number;
  /** Callback when speech starts */
  onSpeechStart?: () => void;
  /** Callback when speech ends */
  onSpeechEnd?: () => void;
  /** Callback with current RMS level for UI visualization */
  onLevel?: (rms: number, threshold: number) => void;
}

export class VAD {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private dataArray: Float32Array<ArrayBuffer> | null = null;

  private noiseFloor = 0;
  private threshold: number;
  private silenceMs: number;
  private minSpeechMs: number;
  private intervalMs: number;

  private isSpeaking = false;
  private speechStartTime = 0;
  private lastSpeechTime = 0;
  private active = false;
  private paused = false;

  private onSpeechStart?: () => void;
  private onSpeechEnd?: () => void;
  private onLevel?: (rms: number, threshold: number) => void;

  constructor(options: VADOptions = {}) {
    this.threshold = options.threshold ?? 0.015;
    this.silenceMs = options.silenceMs ?? 1500;
    this.minSpeechMs = options.minSpeechMs ?? 300;
    this.intervalMs = options.intervalMs ?? 50;
    this.onSpeechStart = options.onSpeechStart;
    this.onSpeechEnd = options.onSpeechEnd;
    this.onLevel = options.onLevel;
  }

  /** Start listening to the mic */
  async start(): Promise<void> {
    if (this.active) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioCtx = new AudioContext();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);
    this.dataArray = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
    this.active = true;
    this.isSpeaking = false;
    this.paused = false;

    this.interval = setInterval(() => this.analyze(), this.intervalMs);
  }

  /** Stop listening entirely */
  stop(): void {
    this.active = false;
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.source) { this.source.disconnect(); this.source = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
    this.analyser = null;
    this.dataArray = null;
    if (this.isSpeaking) {
      this.isSpeaking = false;
      this.onSpeechEnd?.();
    }
  }

  /** Temporarily pause detection (e.g. while TTS is playing) */
  pause(): void { this.paused = true; }

  /** Resume detection */
  resume(): void { this.paused = false; this.lastSpeechTime = 0; }

  get isActive(): boolean { return this.active; }
  get isPaused(): boolean { return this.paused; }

  /** Get the mic stream (for MediaRecorder) */
  getStream(): MediaStream | null { return this.stream; }

  /** Set noise floor from calibration */
  setNoiseFloor(level: number): void { this.noiseFloor = level; }
  getNoiseFloor(): number { return this.noiseFloor; }
  getEffectiveThreshold(): number { return this.noiseFloor + this.threshold; }

  /** Calibrate: measure ambient noise for given duration */
  async calibrate(durationMs = 3000): Promise<number> {
    if (!this.analyser || !this.dataArray) throw new Error('VAD not started');

    const samples: number[] = [];
    const start = Date.now();

    return new Promise((resolve) => {
      const cal = setInterval(() => {
        const rms = this.getRMS();
        samples.push(rms);
        if (Date.now() - start >= durationMs) {
          clearInterval(cal);
          // Use 95th percentile as noise floor
          samples.sort((a, b) => a - b);
          const p95 = samples[Math.floor(samples.length * 0.95)] || 0;
          this.noiseFloor = p95;
          console.log(`VAD calibrated: noise floor = ${p95.toFixed(4)}, threshold = ${this.getEffectiveThreshold().toFixed(4)}, samples = ${samples.length}`);
          resolve(p95);
        }
      }, this.intervalMs);
    });
  }

  private getRMS(): number {
    if (!this.analyser || !this.dataArray) return 0;
    this.analyser.getFloatTimeDomainData(this.dataArray);
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      sum += this.dataArray[i] * this.dataArray[i];
    }
    return Math.sqrt(sum / this.dataArray.length);
  }

  private analyze(): void {
    if (!this.active || this.paused) return;

    const rms = this.getRMS();
    const effectiveThreshold = this.getEffectiveThreshold();
    this.onLevel?.(rms, effectiveThreshold);

    const now = Date.now();

    if (rms > effectiveThreshold) {
      this.lastSpeechTime = now;
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartTime = now;
        this.onSpeechStart?.();
      }
    } else if (this.isSpeaking) {
      // Check if silence has lasted long enough
      if (now - this.lastSpeechTime > this.silenceMs) {
        const speechDuration = now - this.speechStartTime;
        this.isSpeaking = false;
        if (speechDuration >= this.minSpeechMs) {
          this.onSpeechEnd?.();
        }
        // If too short, just reset silently
      }
    }
  }
}
