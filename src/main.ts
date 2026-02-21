import './style.css';
import { marked } from 'marked';
import { soundRecordStart, soundRecordStop, soundSendSuccess, soundResponseReceived, soundError, startTranscribingSound, stopTranscribingSound, startThinkingSound, stopThinkingSound, unlockAudioCtx, soundCalibrationBeep, soundVadSpeechStart, soundVadListening } from './sounds';
import { VAD } from './vad';

marked.setOptions({ breaks: true });

function renderMarkdown(text: string): string {
  try { return marked.parse(text) as string; } catch { return escapeHtml(text).replace(/\n/g, '<br>'); }
}

const BASE = import.meta.env.BASE_URL;

interface Message {
  role: 'user' | 'assistant';
  text: string;
  audioUrl?: string;
  timestamp: number;
  audioPlayed?: boolean;
}

// --- Pending tasks (in-memory only) ---
let pendingTaskIds = new Set<string>();

function addPendingTask(taskId: string) {
  pendingTaskIds.add(taskId);
}

function removePendingTask(taskId: string) {
  pendingTaskIds.delete(taskId);
}

function pushMessage(msg: Message) {
  messages.push(msg);
}

// --- State ---
let messages: Message[] = [];
let isRecording = false;
let mediaRecorder: MediaRecorder | null = null;
let recordingStartTime = 0;
let audioChunks: Blob[] = [];
let ws: WebSocket | null = null;
let pendingRequests = 0;
let recordingCooldown = false;
let selectedVoice = localStorage.getItem('openclaw-whisper-voice') || 'nova';
let autoPlayTTS = localStorage.getItem('openclaw-whisper-autoplay') !== 'false';
let playbackSpeed = parseFloat(localStorage.getItem('openclaw-whisper-speed') || '1');
let volumeBoost = parseFloat(localStorage.getItem('openclaw-whisper-volume') || '100');

// --- VAD (Voice Activity Detection) ---
let vadMode = false;
let vadCalibrating = false;
let vadCalibrationStep = ''; // 'silence' | 'speak' | 'done'
let vad: VAD | null = null;
let vadLevel = 0;
let vadThreshold = 0;
let ttsPlaying = false; // track when TTS is playing to pause VAD

// --- Streaming text ---
let streamingText = ''; // partial text from current stream
let activeStreamId = ''; // streamId we're tracking


// Web Audio gain node for volume boost beyond 100%
let gainNode: GainNode | null = null;
let mediaSource: MediaElementAudioSourceNode | null = null;
let boostCtx: AudioContext | null = null;

function applyVolumeBoost(audioEl: HTMLAudioElement) {
  // If GainNode already created, must use it (createMediaElementSource is irreversible)
  if (mediaSource && gainNode) {
    if (boostCtx && boostCtx.state === 'suspended') boostCtx.resume();
    audioEl.volume = 1;
    gainNode.gain.value = volumeBoost / 100;
    return;
  }

  // For volumes <= 100%, use native volume (no Web Audio needed)
  if (volumeBoost <= 100) {
    audioEl.volume = volumeBoost / 100;
    return;
  }

  // For volumes > 100%, create Web Audio GainNode (one-time, irreversible per element)
  if (!boostCtx) boostCtx = new AudioContext();
  if (boostCtx.state === 'suspended') boostCtx.resume();

  mediaSource = boostCtx.createMediaElementSource(audioEl);
  gainNode = boostCtx.createGain();
  mediaSource.connect(gainNode);
  gainNode.connect(boostCtx.destination);

  audioEl.volume = 1;
  gainNode.gain.value = volumeBoost / 100;
}

// Persistent audio element for TTS playback (unlocked on user gesture)
// This element gets embedded into the DOM as the visible player
let ttsAudio: HTMLAudioElement | null = null;
let ttsPlayingMsgIdx: number = -1; // which message index is currently using ttsAudio
function ensureTtsAudio(): HTMLAudioElement {
  if (!ttsAudio) {
    ttsAudio = new Audio();
    ttsAudio.controls = true;
    ttsAudio.volume = 1;
    ttsAudio.preload = 'auto';
    // Pause VAD while TTS is playing to avoid picking up speaker output
    // Pause VAD while TTS is playing — ignore silent unlock buffer
    const isRealAudio = () => !!(ttsAudio!.duration && ttsAudio!.duration > 0.5 && isFinite(ttsAudio!.duration));
    ttsAudio.addEventListener('play', () => { ttsAudio!.playbackRate = playbackSpeed; if (isRealAudio()) { ttsPlaying = true; if (vad) vad.pause(); } });
    ttsAudio.addEventListener('pause', () => { ttsPlaying = false; if (vad && vadMode) { vad.resume(); soundVadListening(); } });
    ttsAudio.addEventListener('ended', () => { ttsPlaying = false; if (vad && vadMode) { vad.resume(); soundVadListening(); } });
  }
  return ttsAudio;
}
// Unlock audio on first user interaction
function unlockAudio() {
  const a = ensureTtsAudio();
  // Play a silent buffer to unlock
  const wasSrc = a.src;
  a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  a.play().then(() => { a.pause(); a.currentTime = 0; ttsPlaying = false; if (wasSrc) a.src = wasSrc; }).catch(() => { ttsPlaying = false; });
}

// --- Render ---
function render() {
 try {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <header>
      <h1>🎙️ OpenClaw Whisper</h1>
      <div class="subtitle">Voice chat powered by Whisper STT + OpenAI TTS</div>
    </header>
    <div class="status-bar">
      <div class="status-dot ${ws && ws.readyState === WebSocket.OPEN ? 'connected' : ''}"></div>
      <span>${ws && ws.readyState === WebSocket.OPEN ? 'Connected to OpenClaw' : 'Disconnected'}</span>
    </div>
    <div class="conversation" id="conversation">
      ${messages.length === 0 ? '<div class="empty-state">Tap the mic to start recording, tap again to send</div>' : ''}
      ${messages.map((m, i) => `
        <div class="message ${m.role}">
          <div class="bubble">${renderMarkdown(String(m.text || ''))}</div>
          ${m.audioUrl ? `<div class="audio-slot" data-msg-idx="${i}"></div>` : ''}
          <div class="meta">${new Date(m.timestamp).toLocaleTimeString()}</div>
        </div>
      `).join('')}
      ${pendingRequests > 0 ? `
        <div class="message assistant">
          <div class="thinking">
            <div class="spinner"></div>
            <span> Thinking...</span>
          </div>
          ${streamingText ? `<div class="bubble streaming">${renderMarkdown(streamingText)}</div>` : ''}
        </div>
      ` : ''}
    </div>
    <div class="controls">
      <div class="controls-row">
        <button class="ptt-btn ${isRecording ? 'recording' : ''}" id="pttBtn" ${recordingCooldown || vadMode ? 'disabled' : ''}>
          ${isRecording ? '⏹' : '🎤'}
        </button>
        <button class="vad-btn ${vadMode ? 'active' : ''}" id="vadBtn">
          ${vadMode ? '🔴' : '🎙️'}
        </button>
        <button class="calibrate-btn" id="calibrateBtn" title="Calibrate microphone" ${vadCalibrating ? 'disabled' : ''}>
          ${vadCalibrating ? '📊' : '🎚️'}
        </button>
        <button class="clear-btn" id="clearBtn" title="Clear local data">🗑️</button>
      </div>
      ${vadMode || vadCalibrating ? `
      <div class="vad-status">
        ${vadCalibrating ? (
          vadCalibrationStep === 'silence' ? `<div class="vad-calibrating">🔇 Stay silent for 3 seconds...</div>` :
          vadCalibrationStep === 'speak' ? `<div class="vad-calibrating">🗣️ Read this aloud (stop when done):<br><span class="calibration-phrase">"${calibrationPhrase}"</span></div>` :
          `<div class="vad-calibrating">✅ Calibration complete!</div>`
        ) : 
          `<div class="vad-listening">${ttsPlaying ? '⏸️ Paused (TTS playing)' : isRecording ? '🔴 Recording...' : '👂 Listening...'}</div>`}
        <div class="vad-level-bar"><div class="vad-level" id="vadLevel"></div></div>
      </div>
      ` : ''}
      <div class="settings">
        <select id="voiceSelect">
          <option disabled>— Voice —</option>
          ${['alloy','ash','ballad','coral','echo','fable','nova','onyx','shimmer'].map(v =>
            `<option value="${v}" ${v === selectedVoice ? 'selected' : ''}>${v}</option>`
          ).join('')}
        </select>
        <select id="speedSelect">
          <option disabled>— Speed —</option>
          ${['0.25','0.5','0.75','1','1.25','1.5','1.75','2'].map(s =>
            `<option value="${s}" ${parseFloat(s) === playbackSpeed ? 'selected' : ''}>${s}x</option>`
          ).join('')}
        </select>
        <button class="btn ${autoPlayTTS ? 'active' : ''}" id="autoPlayBtn">🔊</button>
      </div>
    </div>
  `;

  // Scroll to bottom (use rAF to ensure layout is complete)
  const conv = document.getElementById('conversation')!;
  requestAnimationFrame(() => { conv.scrollTop = conv.scrollHeight; });

  // Bind events
  bindEvents();

  // Embed audio elements into slots
  const audioSlots = conv.querySelectorAll('.audio-slot');
  audioSlots.forEach(slot => {
    const idx = parseInt((slot as HTMLElement).dataset.msgIdx || '-1');
    if (idx < 0 || idx >= messages.length) return;
    const m = messages[idx];
    if (!m.audioUrl) return;

    if (idx === ttsPlayingMsgIdx) {
      // Embed the persistent ttsAudio element here
      slot.appendChild(ensureTtsAudio());
    } else {
      // Regular audio element for user recordings / old messages
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = m.audioUrl;
      audio.preload = 'auto';
      audio.playbackRate = playbackSpeed;
      slot.appendChild(audio);
    }
  });

  // Auto-play pending assistant audio via persistent element
  if (autoPlayTTS && !isRecording) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'assistant' && m.audioUrl && !m.audioPlayed) {
        m.audioPlayed = true;
        ttsPlayingMsgIdx = i;
        const a = ensureTtsAudio();
        a.src = m.audioUrl;
        
        
        a.play().catch((e) => console.warn('TTS autoplay blocked:', e));
        // Re-embed since ttsPlayingMsgIdx changed
        const slot = conv.querySelector(`.audio-slot[data-msg-idx="${i}"]`);
        if (slot) { slot.innerHTML = ''; slot.appendChild(a); }
        conv.scrollTop = conv.scrollHeight;
        break;
      }
    }
  }
 } catch (err) { console.error('Process error:', err); }
}

function extractText(content: any): string {
  try {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c: any) => typeof c === 'string' ? c : (c?.text || '')).filter(Boolean).join('\n');
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
    return typeof content === 'undefined' || content === null ? '' : String(content);
  } catch { return '[error extracting text]'; }
}

function escapeHtml(text: string): string {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bindEvents() {
  const pttBtn = document.getElementById('pttBtn')!;
  const voiceSelect = document.getElementById('voiceSelect') as HTMLSelectElement;
  const autoPlayBtn = document.getElementById('autoPlayBtn')!;
  const resetBtn = document.getElementById('resetBtn');

  // Tap to toggle recording
  const toggleRec = (e: Event) => {
    e.preventDefault();
    unlockAudio();
    unlockAudioCtx();
    if (recordingCooldown) return;
    if (isRecording) stopRecording();
    else startRecording();
  };

  pttBtn.addEventListener('click', toggleRec);

  voiceSelect.addEventListener('change', () => { selectedVoice = voiceSelect.value; localStorage.setItem('openclaw-whisper-voice', selectedVoice); });
  const speedSelect = document.getElementById('speedSelect') as HTMLSelectElement;
  speedSelect.addEventListener('change', () => { playbackSpeed = parseFloat(speedSelect.value); localStorage.setItem('openclaw-whisper-speed', String(playbackSpeed)); });
  autoPlayBtn.addEventListener('click', () => { autoPlayTTS = !autoPlayTTS; localStorage.setItem('openclaw-whisper-autoplay', String(autoPlayTTS)); render(); });
  resetBtn?.addEventListener('click', resetSession);

  document.getElementById('vadBtn')?.addEventListener('click', () => toggleVadMode());

  const calibrateBtn = document.getElementById('calibrateBtn');
  calibrateBtn?.addEventListener('click', () => {
    unlockAudio();
    unlockAudioCtx();
    startCalibration();
  });

  const clearBtn = document.getElementById('clearBtn');
  clearBtn?.addEventListener('click', () => {
    if (confirm('Clear all local data? This removes cached messages, settings, and reloads the page.')) {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('openclaw-whisper'));
      keys.forEach(k => localStorage.removeItem(k));
      location.reload();
    }
  });
}

// --- Recording ---
let ttsWasPlaying = false;
let ttsResumeTime = 0;

function stopTtsPlayback() {
  if (ttsAudio && !ttsAudio.paused) {
    ttsWasPlaying = true;
    ttsResumeTime = ttsAudio.currentTime;
    ttsAudio.pause();
  } else {
    ttsWasPlaying = false;
  }
}

function resumeTtsPlayback() {
  if (ttsWasPlaying && ttsAudio && ttsAudio.src) {
    ttsAudio.currentTime = ttsResumeTime;
    
    ttsAudio.play().catch(() => { ttsPlaying = false; if (vad && vadMode) vad.resume(); });
    ttsWasPlaying = false;
  } else {
    // Nothing to resume — make sure VAD is listening
    ttsWasPlaying = false;
    ttsPlaying = false;
    if (vad && vadMode) vad.resume();
  }
}

async function startRecording() {
  stopTtsPlayback();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: getSupportedMimeType() });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      processRecording();
    };
    mediaRecorder.start();
    recordingStartTime = Date.now();
    isRecording = true;
    soundRecordStart();
    render();
  } catch (err) {
    console.error('Mic error:', err);
    alert('Could not access microphone. Please allow microphone access.');
  }
}

// --- VAD recording (uses VAD's persistent stream) ---
function vadStartRecording() {
  if (!vad || isRecording) return;
  stopTtsPlayback();
  const stream = vad.getStream();
  if (!stream) return;

  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: getSupportedMimeType() });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    // Don't stop stream tracks — VAD owns the stream
    processRecording();
  };
  mediaRecorder.start();
  recordingStartTime = Date.now();
  isRecording = true;
  soundVadSpeechStart();
  render();
}

function vadStopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    isRecording = false;
    soundRecordStop();
    render();
    // 500ms silence buffer
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    }, 500);
  }
}

async function toggleVadMode() {
  console.log('toggleVadMode called, current vadMode:', vadMode);
  unlockAudio();
  unlockAudioCtx();

  if (vadMode) {
    // Turn off VAD
    vadMode = false;
    if (vad) { vad.stop(); vad = null; }
    if (isRecording) vadStopRecording();
    render();
    return;
  }

  // Turn on VAD
  vadMode = true;
  render();

  vad = new VAD({
    silenceMs: 2000,
    minSpeechMs: 300,
    onSpeechStart: () => {
      if (!ttsPlaying && !isRecording && !recordingCooldown) {
        vadStartRecording();
      }
    },
    onSpeechEnd: () => {
      if (isRecording) {
        vadStopRecording();
      }
    },
    onLevel: (rms, threshold) => {
      vadLevel = rms;
      vadThreshold = threshold;
      // Update level indicator without full re-render
      const indicator = document.getElementById('vadLevel');
      if (indicator) {
        const pct = Math.min(100, (rms / Math.max(threshold * 3, 0.05)) * 100);
        indicator.style.width = `${pct}%`;
        indicator.style.background = rms > threshold ? '#a6e3a1' : '#585b70';
      }
    },
  });

  try {
    console.log('Starting VAD...');
    await vad.start();
    console.log('VAD started successfully');
    // Restore saved calibration if available
    try {
      const saved = JSON.parse(localStorage.getItem('openclaw-whisper-calibration') || '');
      if (saved.noiseFloor != null) vad.setNoiseFloor(saved.noiseFloor);
      console.log(`Loaded saved calibration: noise=${saved.noiseFloor}`);
    } catch {}
    render();
  } catch (err: any) {
    console.error('VAD start failed:', err);
    alert(`VAD failed to start: ${err.message}`);
    vadMode = false;
    vad = null;
    render();
  }
}

const CALIBRATION_PHRASES = [
  "The quick brown fox jumps over the lazy dog near the riverbank on a warm summer evening.",
  "She sells seashells by the seashore while the waves crash gently against the sandy beach below.",
  "Every morning I wake up early and make a fresh cup of coffee before starting my daily routine.",
  "The old bookstore on the corner has been there for decades, filled with stories waiting to be read.",
  "Walking through the park at sunset, you can hear birds singing their last songs of the day.",
];

let calibrationPhrase = '';

async function startCalibration() {
  // If VAD isn't running yet, start it just for calibration
  const needsStart = !vad;
  if (needsStart) {
    vad = new VAD({
      silenceMs: 1500,
      minSpeechMs: 300,
      onLevel: (rms, threshold) => {
        vadLevel = rms;
        vadThreshold = threshold;
        const indicator = document.getElementById('vadLevel');
        if (indicator) {
          const pct = Math.min(100, (rms / Math.max(threshold * 3, 0.05)) * 100);
          indicator.style.width = `${pct}%`;
          indicator.style.background = rms > threshold ? '#a6e3a1' : '#585b70';
        }
      },
    });
    await vad.start();
  }

  vadCalibrating = true;

  // Step 1: Measure ambient silence
  vadCalibrationStep = 'silence';
  calibrationPhrase = '';
  render();
  soundCalibrationBeep();
  await new Promise(r => setTimeout(r, 500));
  
  await vad!.calibrate(3000);
  soundCalibrationBeep();
  await new Promise(r => setTimeout(r, 500));

  // Step 2: Measure speech — give user something to read
  vadCalibrationStep = 'speak';
  calibrationPhrase = CALIBRATION_PHRASES[Math.floor(Math.random() * CALIBRATION_PHRASES.length)];
  render();
  soundCalibrationBeep();
  await new Promise(r => setTimeout(r, 300));

  // Measure speech levels — minimum 5 seconds, then wait for 2s of silence
  const speechSamples: number[] = [];
  const speechStart = Date.now();
  const MIN_SPEECH_MS = 5000;
  const SILENCE_THRESHOLD_MS = 2000;
  let lastLoudTime = Date.now();
  
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (!vad) { clearInterval(interval); resolve(); return; }
      const rms = vadLevel;
      speechSamples.push(rms);
      const elapsed = Date.now() - speechStart;
      const noiseFloorEst = vad!.getNoiseFloor();
      
      // Track when we last heard speech
      if (rms > noiseFloorEst + 0.005) {
        lastLoudTime = Date.now();
      }
      
      // Only stop after minimum time AND 2s of silence
      if (elapsed >= MIN_SPEECH_MS && (Date.now() - lastLoudTime) >= SILENCE_THRESHOLD_MS) {
        clearInterval(interval);
        resolve();
      }
      
      // Hard cap at 20 seconds
      if (elapsed >= 20000) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });

  // Calculate a good threshold between noise floor and speech level
  speechSamples.sort((a, b) => a - b);
  const speechMedian = speechSamples[Math.floor(speechSamples.length * 0.5)] || 0;
  const noiseFloor = vad!.getNoiseFloor();
  // Set threshold halfway between noise floor and speech, but at least 0.01 above noise
  const newThreshold = Math.max(0.01, (speechMedian - noiseFloor) * 0.4);
  vad!.setNoiseFloor(noiseFloor);
  console.log(`Calibration: noise=${noiseFloor.toFixed(4)}, speech=${speechMedian.toFixed(4)}, threshold=${newThreshold.toFixed(4)}`);
  // Persist calibration
  localStorage.setItem('openclaw-whisper-calibration', JSON.stringify({ noiseFloor, threshold: newThreshold }));

  // Step 3: Done
  soundCalibrationBeep();
  await new Promise(r => setTimeout(r, 200));
  soundCalibrationBeep();

  vadCalibrating = false;
  vadCalibrationStep = 'done';
  calibrationPhrase = '';

  // If we started VAD just for calibration and VAD mode isn't on, stop it
  if (needsStart && !vadMode && vad) {
    vad.stop();
    vad = null;
  }

  soundVadListening();
  render();
}

function getSupportedMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of types) { if (MediaRecorder.isTypeSupported(t)) return t; }
  return 'audio/webm';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    isRecording = false;
    soundRecordStop();
    render();
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    }, 500);
    return;
  }
  isRecording = false;
  render();
}

async function processRecording() {
  const duration = Date.now() - recordingStartTime;
  if (audioChunks.length === 0 || duration < 2000) return; // min 2 seconds to filter background noise

  // Start cooldown
  recordingCooldown = true;
  render();
  setTimeout(() => { recordingCooldown = false; render(); }, 500);

  const blob = new Blob(audioChunks, { type: 'audio/webm' });

  // Fire off the pipeline without blocking
  handleRecordingPipeline(blob);
}

async function handleRecordingPipeline(blob: Blob) {
  try {
    // 1. Send audio to Whisper STT
    startTranscribingSound();
    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');

    const sttRes = await fetch(`${BASE}api/stt`, { method: 'POST', body: formData });
    stopTranscribingSound();
    if (!sttRes.ok) throw new Error(`STT failed: ${sttRes.statusText}`);
    const { text: userText } = await sttRes.json();

    if (!userText || userText.trim().length === 0) { resumeTtsPlayback(); return; }

    // Require at least 3 words to avoid sending fragments
    const wordCount = userText.trim().split(/\s+/).length;
    if (wordCount < 3) {
      console.log(`Transcription too short (${wordCount} words): "${userText}"`);
      pushMessage({ role: 'user', text: `*(too short: "${userText.trim()}")* `, timestamp: Date.now() });
      render();
      resumeTtsPlayback();
      return;
    }

    // Real message — don't resume old TTS
    ttsWasPlaying = false;

    // Add user message with recorded audio
    const userAudioUrl = URL.createObjectURL(blob);
    pushMessage({ role: 'user', text: userText, audioUrl: userAudioUrl, timestamp: Date.now() });
    pendingRequests++;
    render();

    // 2. Send to OpenClaw (with progressive TTS)
    soundSendSuccess();
    startThinkingSound();
    streamingText = '';
    activeStreamId = '*'; // accept any stream

    const chatRes = await fetch(`${BASE}api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userText }),
    });

    if (!chatRes.ok) { stopThinkingSound(); throw new Error(`Chat failed: ${chatRes.statusText}`); }

    // 3. Get response
    const chatData = await chatRes.json();
    const resultText = chatData.text || chatData.choices?.[0]?.message?.content || 'No response';
    stopThinkingSound();
    streamingText = '';
    activeStreamId = '';

    // 4. Get TTS audio
    let audioUrl: string | undefined;
    try {
      const ttsRes = await fetch(`${BASE}api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: resultText, voice: selectedVoice }),
      });
      if (ttsRes.ok) {
        const audioBlob = await ttsRes.blob();
        audioUrl = URL.createObjectURL(audioBlob);
      }
    } catch (e) {
      console.warn('TTS failed:', e);
    }

    // Add message
    soundResponseReceived();
    await new Promise(r => setTimeout(r, 400));
    const msg: Message = { role: 'assistant', text: resultText, audioUrl, timestamp: Date.now(), audioPlayed: !!audioUrl };
    pushMessage(msg);
  } catch (err: any) {
    console.error('Process error:', err);
    stopTranscribingSound();
    stopThinkingSound();
    soundError();
    pushMessage({ role: 'assistant', text: `Error: ${err.message}`, timestamp: Date.now() });
  }

  pendingRequests = Math.max(0, pendingRequests - 1);
  render();

  const lastMsgIdx = messages.length - 1;
  const lastMsg = messages[lastMsgIdx];
  if (lastMsg?.audioUrl && lastMsg.role === 'assistant') {
    ttsPlayingMsgIdx = lastMsgIdx;
    const a = ensureTtsAudio();
    a.src = lastMsg.audioUrl;
    
    
    render();
    // Embed and autoplay
    if (autoPlayTTS && !isRecording) {
      const conv = document.getElementById('conversation');
      const slot = conv?.querySelector(`.audio-slot[data-msg-idx="${lastMsgIdx}"]`);
      if (slot) { slot.innerHTML = ''; slot.appendChild(a); }
      a.play().catch((e) => console.warn('TTS autoplay blocked:', e));
      if (conv) conv.scrollTop = conv.scrollHeight;
    }
  }
}

function waitForResult(taskId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for response'));
    }, 120000);

    function handler(event: MessageEvent) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'result' && msg.taskId === taskId) {
          cleanup();
          resolve(msg.text);
        }
      } catch {}
    }

    function cleanup() {
      clearTimeout(timeout);
      ws?.removeEventListener('message', handler);
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.addEventListener('message', handler);
    } else {
      reject(new Error('WebSocket not connected'));
    }
  });
}

// --- WebSocket ---
function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}${BASE}ws`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => { console.log('WS connected'); render(); };
  ws.onclose = () => {
    console.log('WS disconnected, reconnecting...');
    render();
    setTimeout(connectWs, 3000);
  };
  ws.onerror = (err) => console.error('WS error:', err);
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'stream' && (activeStreamId === '*' || msg.streamId === activeStreamId)) {
        if (activeStreamId === '*') activeStreamId = msg.streamId; // lock to this stream
        streamingText = msg.text || '';
        // Update streaming bubble without full re-render
        const streamBubble = document.querySelector('.bubble.streaming');
        if (streamBubble) {
          streamBubble.innerHTML = renderMarkdown(streamingText);
          const conv = document.getElementById('conversation');
          if (conv) conv.scrollTop = conv.scrollHeight;
        } else {
          render(); // first chunk — need full render to create the bubble
        }
      } else if (msg.type === 'stream-end' && msg.streamId === activeStreamId) {
        streamingText = '';
        activeStreamId = '';
      } else if (msg.type === 'result' && pendingRequests === 0) {
        handleAsyncResult(msg);
      }
    } catch {}
  };
}

async function handleAsyncResult(msg: any) {
  let audioUrl: string | undefined;
  try {
    const ttsRes = await fetch(`${BASE}api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msg.text, voice: selectedVoice }),
    });
    if (ttsRes.ok) {
      const audioBlob = await ttsRes.blob();
      audioUrl = URL.createObjectURL(audioBlob);
    }
  } catch {}

  pushMessage({ role: 'assistant', text: msg.text, audioUrl, timestamp: Date.now() });
  render();
}

async function resetSession() {
  await fetch(`${BASE}api/session/reset`, { method: 'POST' });
  messages = [];
  render();
}

// --- Load chat history from gateway ---
async function loadHistory() {
  try {
    const res = await fetch(`${BASE}api/history`);
    if (!res.ok) { console.warn('History load failed:', res.status); return; }
    const data = await res.json();
    const history: any[] = data.messages || data || [];
    // Gateway returns oldest-first; filter to only user/assistant text messages
    for (const m of history) {
      // Skip system messages, tool calls, tool results
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      
      const content = m.content || m.text || '';
      
      // Skip tool call messages (content is array of tool calls, not text)
      if (Array.isArray(content)) {
        // Extract only text parts from content arrays
        const textParts = content
          .filter((c: any) => c.type === 'text' && c.text)
          .map((c: any) => c.text)
          .join('\n');
        if (!textParts) continue;
        messages.push({ role: m.role, text: textParts, timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now() });
        continue;
      }
      
      if (typeof content !== 'string' || !content.trim()) continue;
      
      // Skip internal markers
      if (content === 'NO_REPLY' || content === 'HEARTBEAT_OK') continue;
      
      messages.push({ role: m.role, text: content, timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now() });
    }
    render();
  } catch (err) {
    console.warn('Failed to load history:', err);
  }
}

// --- Init ---
connectWs();
render();
loadHistory();

// Keyboard shortcut: Space to toggle recording
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !recordingCooldown && !vadMode && document.activeElement?.tagName !== 'SELECT') {
    e.preventDefault();
    if (isRecording) stopRecording();
    else startRecording();
  }
});
