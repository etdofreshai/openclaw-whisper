import './style.css';
// Simple markdown-like rendering (no heavy parser)
import { soundRecordStart, soundRecordStop, soundSendSuccess, soundResponseReceived, soundError, startTranscribingSound, stopTranscribingSound, startThinkingSound, stopThinkingSound, unlockAudioCtx } from './sounds';

function simpleMarkdown(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

const BASE = import.meta.env.BASE_URL;

interface Message {
  role: 'user' | 'assistant';
  text: string;
  audioUrl?: string;
  timestamp: number;
  audioPlayed?: boolean;
}

// --- Persistence ---
const STORAGE_KEY_MESSAGES = 'openclaw-whisper-messages';
const STORAGE_KEY_PENDING = 'openclaw-whisper-pending';

interface PendingTask {
  taskId: string;
  timestamp: number;
}

function saveMessages() {
  // Save messages without blob audioUrls (those don't survive reload)
  const serializable = messages.map(m => ({ ...m, audioUrl: undefined }));
  try { localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(serializable)); } catch {}
}

function loadMessages(): Message[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MESSAGES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((m: any) => ({
        ...m,
        text: typeof m.text === 'string' ? m.text : extractText(m.text) || '[message]',
        role: m.role === 'user' ? 'user' : 'assistant',
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
      }));
    }
  } catch {
    // Corrupt localStorage — clear it
    try { localStorage.removeItem(STORAGE_KEY_MESSAGES); } catch {}
  }
  return [];
}

function savePendingTasks(tasks: PendingTask[]) {
  try { localStorage.setItem(STORAGE_KEY_PENDING, JSON.stringify(tasks)); } catch {}
}

function loadPendingTasks(): PendingTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PENDING);
    if (raw) {
      const tasks: PendingTask[] = JSON.parse(raw);
      // Expire tasks older than 5 minutes
      const cutoff = Date.now() - 5 * 60 * 1000;
      return tasks.filter(t => t.timestamp > cutoff);
    }
  } catch {}
  return [];
}

let pendingTasks: PendingTask[] = loadPendingTasks();

function addPendingTask(taskId: string) {
  pendingTasks.push({ taskId, timestamp: Date.now() });
  savePendingTasks(pendingTasks);
}

function removePendingTask(taskId: string) {
  pendingTasks = pendingTasks.filter(t => t.taskId !== taskId);
  savePendingTasks(pendingTasks);
}

function pushMessage(msg: Message) {
  messages.push(msg);
  saveMessages();
}

function clearMessages() {
  messages = [];
  saveMessages();
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

// Web Audio gain node for volume boost beyond 100%
let gainNode: GainNode | null = null;
let mediaSource: MediaElementAudioSourceNode | null = null;
let boostCtx: AudioContext | null = null;

function applyVolumeBoost(audioEl: HTMLAudioElement) {
  if (!boostCtx) boostCtx = new AudioContext();
  if (boostCtx.state === 'suspended') boostCtx.resume();

  // Only create the source node once per element
  if (!mediaSource) {
    mediaSource = boostCtx.createMediaElementSource(audioEl);
    gainNode = boostCtx.createGain();
    mediaSource.connect(gainNode);
    gainNode.connect(boostCtx.destination);
  }

  // Set gain (1.0 = 100%, 2.0 = 200%)
  if (gainNode) gainNode.gain.value = volumeBoost / 100;
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
  }
  return ttsAudio;
}
// Unlock audio on first user interaction
function unlockAudio() {
  const a = ensureTtsAudio();
  // Play a silent buffer to unlock
  const wasSrc = a.src;
  a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  a.play().then(() => { a.pause(); a.currentTime = 0; if (wasSrc) a.src = wasSrc; }).catch(() => {});
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
          <div class="bubble">${simpleMarkdown(String(m.text || ''))}</div>
          ${m.audioUrl ? `<div class="audio-slot" data-msg-idx="${i}"></div>` : ''}
          <div class="meta">${new Date(m.timestamp).toLocaleTimeString()}</div>
        </div>
      `).join('')}
      ${pendingRequests > 0 ? `
        <div class="message assistant">
          <div class="thinking"><div class="spinner"></div> Thinking...</div>
        </div>
      ` : ''}
    </div>
    <div class="controls">
      <div class="controls-row">
        <button class="ptt-btn ${isRecording ? 'recording' : ''}" id="pttBtn" ${recordingCooldown ? 'disabled' : ''}>
          ${isRecording ? '⏹' : '🎤'}
        </button>
        <button class="clear-btn" id="clearBtn" title="Clear local data">🗑️</button>
      </div>
      <div class="settings">
        <select id="voiceSelect">
          <option disabled>— Voice —</option>
          ${['alloy','ash','ballad','coral','echo','fable','nova','onyx','shimmer'].map(v =>
            `<option value="${v}" ${v === selectedVoice ? 'selected' : ''}>${v}</option>`
          ).join('')}
        </select>
        <select id="speedSelect">
          <option disabled>— Speed —</option>
          ${['0.5','0.75','1','1.25','1.5','1.75','2'].map(s =>
            `<option value="${s}" ${parseFloat(s) === playbackSpeed ? 'selected' : ''}>${s}x</option>`
          ).join('')}
        </select>
        <select id="volumeSelect">
          <option disabled>— Volume —</option>
          ${['50','75','100','125','150','175','200'].map(v =>
            `<option value="${v}" ${parseFloat(v) === volumeBoost ? 'selected' : ''}>${v}%</option>`
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
        a.playbackRate = playbackSpeed;
        applyVolumeBoost(a);
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
  pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); toggleRec(e); });

  const speedSelect = document.getElementById('speedSelect') as HTMLSelectElement;

  voiceSelect.addEventListener('change', () => { selectedVoice = voiceSelect.value; localStorage.setItem('openclaw-whisper-voice', selectedVoice); });
  const volumeSelect = document.getElementById('volumeSelect') as HTMLSelectElement;

  speedSelect.addEventListener('change', () => { playbackSpeed = parseFloat(speedSelect.value); localStorage.setItem('openclaw-whisper-speed', String(playbackSpeed)); });
  volumeSelect.addEventListener('change', () => { volumeBoost = parseFloat(volumeSelect.value); localStorage.setItem('openclaw-whisper-volume', String(volumeBoost)); if (ttsAudio) applyVolumeBoost(ttsAudio); });
  autoPlayBtn.addEventListener('click', () => { autoPlayTTS = !autoPlayTTS; localStorage.setItem('openclaw-whisper-autoplay', String(autoPlayTTS)); render(); });
  resetBtn?.addEventListener('click', resetSession);

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
async function startRecording() {
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
  if (audioChunks.length === 0 || duration < 300) return; // min 300ms

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

    if (!userText || userText.trim().length === 0) return;

    // Add user message with recorded audio
    const userAudioUrl = URL.createObjectURL(blob);
    pushMessage({ role: 'user', text: userText, audioUrl: userAudioUrl, timestamp: Date.now() });
    pendingRequests++;
    render();

    // 2. Send to OpenClaw
    soundSendSuccess();
    startThinkingSound();

    const chatRes = await fetch(`${BASE}api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userText }),
    });

    if (!chatRes.ok) { stopThinkingSound(); throw new Error(`Chat failed: ${chatRes.statusText}`); }

    // 3. Get response (synchronous HTTP — waits for full response)
    const chatData = await chatRes.json();
    const resultText = chatData.text || chatData.choices?.[0]?.message?.content || 'No response';
    stopThinkingSound();

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

    // Play chime, then add message
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

  // Directly autoplay the TTS using the persistent (unlocked) audio element
  const lastMsgIdx = messages.length - 1;
  const lastMsg = messages[lastMsgIdx];
  if (autoPlayTTS && !isRecording && lastMsg?.audioUrl && lastMsg.role === 'assistant') {
    ttsPlayingMsgIdx = lastMsgIdx;
    const a = ensureTtsAudio();
    a.src = lastMsg.audioUrl;
    a.playbackRate = playbackSpeed;
    applyVolumeBoost(a);
    // Embed into the correct slot
    const conv = document.getElementById('conversation');
    const slot = conv?.querySelector(`.audio-slot[data-msg-idx="${lastMsgIdx}"]`);
    if (slot) { slot.innerHTML = ''; slot.appendChild(a); }
    a.play().catch((e) => console.warn('TTS autoplay blocked:', e));
    // Scroll to bottom after embedding
    if (conv) conv.scrollTop = conv.scrollHeight;
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
      if (msg.type === 'result' && pendingRequests === 0) {
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
  clearMessages();
  render();
}

// --- Init ---
// Emergency clear via URL param
if (new URLSearchParams(window.location.search).has('clear')) {
  Object.keys(localStorage).filter(k => k.startsWith('openclaw-whisper')).forEach(k => localStorage.removeItem(k));
  window.history.replaceState({}, '', window.location.pathname);
  console.log('localStorage cleared via ?clear param');
}

// Restore persisted messages
const savedMessages = loadMessages();
if (savedMessages.length > 0) {
  try {
    messages = savedMessages.map(m => {
      const text = typeof m.text === 'string' ? m.text : String(extractText(m.text) || '');
      if (typeof text !== 'string') throw new Error('non-string text after extract');
      return { ...m, text, audioPlayed: true, audioUrl: undefined };
    });
  } catch (e) {
    console.error('Corrupt messages in localStorage, clearing:', e);
    localStorage.removeItem(STORAGE_KEY_MESSAGES);
    messages = [];
  }
}

connectWs();
render();

// Clear any stale pending tasks from previous WS-based flow
savePendingTasks([]);

// Keyboard shortcut: Space to toggle recording
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !recordingCooldown && document.activeElement?.tagName !== 'SELECT') {
    e.preventDefault();
    if (isRecording) stopRecording();
    else startRecording();
  }
});
