import './style.css';
import { marked } from 'marked';
import { soundRecordStart, soundRecordStop, soundSendSuccess, soundResponseReceived, soundError, startThinkingSound, stopThinkingSound } from './sounds';

marked.setOptions({ breaks: true });

const BASE = import.meta.env.BASE_URL;

interface Message {
  role: 'user' | 'assistant';
  text: string;
  audioUrl?: string;
  timestamp: number;
  audioPlayed?: boolean;
}

interface Session {
  sessionKey: string;
  label?: string;
  lastMessage?: string;
  lastActivity?: string;
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
let sessions: Session[] = [];
const DEFAULT_SESSION = 'whisper-voice:ET';
let selectedSessionKey: string = DEFAULT_SESSION;
let sessionsLoading = false;
let showSessionPanel = false;
let sessionSearchQuery = '';

// --- Sessions ---
async function loadSessions() {
  sessionsLoading = true;
  render();
  try {
    const res = await fetch(`${BASE}api/sessions`);
    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data) ? data : (data.sessions || []);
      sessions = raw.map((s: any) => ({
        sessionKey: s.sessionKey || s.key || '',
        label: s.label || s.displayName || s.key || '',
        lastMessage: typeof s.lastMessage === 'string' ? s.lastMessage : '',
        lastActivity: s.lastActivity || s.updatedAt || '',
      }));
    }
  } catch (e) {
    console.error('Failed to load sessions:', e);
  }
  sessionsLoading = false;
  render();
}

async function selectSession(sessionKey: string) {
  selectedSessionKey = sessionKey;
  messages = [];
  showSessionPanel = false;
  render();

  try {
    const res = await fetch(`${BASE}api/sessions/${encodeURIComponent(sessionKey)}/history`);
    if (res.ok) {
      const data = await res.json();
      const hist = Array.isArray(data) ? data : (data.messages || []);
      messages = hist.map((m: any) => ({
        role: m.role === 'user' || m.sender === 'user' ? 'user' as const : 'assistant' as const,
        text: extractText(m.text || m.content || m.message || ''),
        timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
      }));
    }
  } catch (e) {
    console.error('Failed to load history:', e);
  }
  render();
}

function getFilteredSessions(): Session[] {
  // Ensure whisper-voice session is always present
  const hasWhisper = sessions.some(s => s.sessionKey === DEFAULT_SESSION);
  const all = hasWhisper ? [...sessions] : [{ sessionKey: DEFAULT_SESSION, label: '🎙️ Whisper Voice' }, ...sessions];
  
  // Sort: whisper-voice pinned first, then by most recent
  const sorted = all.sort((a, b) => {
    if (a.sessionKey === DEFAULT_SESSION) return -1;
    if (b.sessionKey === DEFAULT_SESSION) return 1;
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return tb - ta;
  });
  if (!sessionSearchQuery.trim()) return sorted;
  const q = sessionSearchQuery.toLowerCase();
  return sorted.filter(s => 
    s.sessionKey === DEFAULT_SESSION || // always show whisper-voice
    getSessionLabel(s).toLowerCase().includes(q) ||
    s.sessionKey.toLowerCase().includes(q) ||
    (s.lastMessage || '').toLowerCase().includes(q)
  );
}

function getSessionLabel(s: Session): string {
  if (s.label) return s.label;
  // Try to make sessionKey human-readable
  const key = s.sessionKey;
  // Remove common prefixes
  return key.replace(/^agent:main:/, '').replace(/:/g, ' › ');
}

// --- Render ---
function render() {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <header>
      <h1>🎙️ OpenClaw Whisper</h1>
      <div class="subtitle">Voice chat powered by Whisper STT + OpenAI TTS</div>
    </header>
    <div class="session-bar">
      <button class="session-toggle-btn" id="sessionToggleBtn">
        📋 ${getSessionLabel({ sessionKey: selectedSessionKey })}
        <span class="caret">▾</span>
      </button>
    </div>
    ${showSessionPanel ? `
    <div class="session-panel" id="sessionPanel">
      <div class="session-panel-header">
        <span>Sessions</span>
        <button class="session-refresh-btn" id="sessionRefreshBtn">🔄</button>
      </div>
      <div class="session-search">
        <input type="text" id="sessionSearchInput" placeholder="Search sessions..." value="${escapeAttr(sessionSearchQuery)}" autocomplete="off" />
      </div>
      <div class="session-list">
        ${sessionsLoading ? '<div class="session-loading"><div class="spinner"></div> Loading...</div>' : ''}
        ${getFilteredSessions().map(s => `
          <button class="session-item ${selectedSessionKey === s.sessionKey ? 'active' : ''}" data-key="${escapeAttr(s.sessionKey)}">
            <div class="session-item-label">${escapeHtml(getSessionLabel(s))}</div>
            ${s.lastMessage ? `<div class="session-item-preview">${escapeHtml(s.lastMessage.slice(0, 60))}</div>` : ''}
          </button>
        `).join('')}
      </div>
    </div>
    ` : ''}
    <div class="status-bar">
      <div class="status-dot ${ws && ws.readyState === WebSocket.OPEN ? 'connected' : ''}"></div>
      <span>${ws && ws.readyState === WebSocket.OPEN ? 'Connected to OpenClaw' : 'Disconnected'}</span>
    </div>
    <div class="conversation" id="conversation">
      ${messages.length === 0 ? '<div class="empty-state">Tap the mic to start recording, tap again to send</div>' : ''}
      ${messages.map(m => `
        <div class="message ${m.role}">
          <div class="bubble">${marked.parse(m.text)}</div>
          ${m.audioUrl ? `<audio controls src="${m.audioUrl}" preload="auto"></audio>` : ''}
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
      </div>
      <div class="settings">
        <label>Voice:</label>
        <select id="voiceSelect">
          ${['alloy','ash','ballad','coral','echo','fable','nova','onyx','shimmer'].map(v =>
            `<option value="${v}" ${v === selectedVoice ? 'selected' : ''}>${v}</option>`
          ).join('')}
        </select>
        <label>Speed:</label>
        <select id="speedSelect">
          ${['0.5','0.75','1','1.25','1.5','1.75','2'].map(s =>
            `<option value="${s}" ${parseFloat(s) === playbackSpeed ? 'selected' : ''}>${s}x</option>`
          ).join('')}
        </select>
        <button class="btn ${autoPlayTTS ? 'active' : ''}" id="autoPlayBtn">🔊 Auto-play</button>
      </div>
    </div>
  `;

  // Scroll to bottom
  const conv = document.getElementById('conversation')!;
  conv.scrollTop = conv.scrollHeight;

  // Bind events
  bindEvents();

  // Set playback speed on all audio elements and auto-play pending assistant audio
  const audioEls = conv.querySelectorAll('audio');
  audioEls.forEach(a => { a.playbackRate = playbackSpeed; });
  if (autoPlayTTS && !isRecording && audioEls.length > 0) {
    // Find the first unplayed assistant message and play it
    let audioIdx = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.audioUrl) {
        if (m.role === 'assistant' && !m.audioPlayed) {
          m.audioPlayed = true;
          const audioEl = audioEls[audioIdx] as HTMLAudioElement;
          audioEl.playbackRate = playbackSpeed;
          audioEl.play().catch(() => {});
          break;
        }
        audioIdx++;
      }
    }
  }
}

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => c.type === 'text' ? c.text : '').filter(Boolean).join('\n');
  if (content && typeof content === 'object' && content.text) return content.text;
  return '';
}

function escapeHtml(text: string): string {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string | undefined | null): string {
  return String(text || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bindEvents() {
  const pttBtn = document.getElementById('pttBtn')!;
  const voiceSelect = document.getElementById('voiceSelect') as HTMLSelectElement;
  const autoPlayBtn = document.getElementById('autoPlayBtn')!;
  const resetBtn = document.getElementById('resetBtn');
  const sessionToggleBtn = document.getElementById('sessionToggleBtn');
  const sessionRefreshBtn = document.getElementById('sessionRefreshBtn');

  // Tap to toggle recording
  const toggleRec = (e: Event) => {
    e.preventDefault();
    if (recordingCooldown) return;
    if (isRecording) stopRecording();
    else startRecording();
  };

  pttBtn.addEventListener('click', toggleRec);
  pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); toggleRec(e); });

  const speedSelect = document.getElementById('speedSelect') as HTMLSelectElement;

  voiceSelect.addEventListener('change', () => { selectedVoice = voiceSelect.value; localStorage.setItem('openclaw-whisper-voice', selectedVoice); });
  speedSelect.addEventListener('change', () => { playbackSpeed = parseFloat(speedSelect.value); localStorage.setItem('openclaw-whisper-speed', String(playbackSpeed)); });
  autoPlayBtn.addEventListener('click', () => { autoPlayTTS = !autoPlayTTS; localStorage.setItem('openclaw-whisper-autoplay', String(autoPlayTTS)); render(); });
  resetBtn?.addEventListener('click', resetSession);

  // Session panel toggle
  sessionToggleBtn?.addEventListener('click', () => {
    showSessionPanel = !showSessionPanel;
    if (!showSessionPanel) sessionSearchQuery = '';
    if (showSessionPanel && sessions.length === 0) loadSessions();
    else render();
  });

  sessionRefreshBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    loadSessions();
  });

  const sessionSearchInput = document.getElementById('sessionSearchInput') as HTMLInputElement;
  sessionSearchInput?.addEventListener('input', () => {
    sessionSearchQuery = sessionSearchInput.value;
    render();
    // Refocus and restore cursor after render
    const input = document.getElementById('sessionSearchInput') as HTMLInputElement;
    if (input) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length; }
  });

  // Session item clicks
  document.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => {
      const key = (el as HTMLElement).dataset.key || DEFAULT_SESSION;
      selectSession(key);
    });
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
    // Keep recording for 500ms of silence buffer before stopping
    // This helps Whisper detect the end of speech cleanly
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
    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');

    const sttRes = await fetch(`${BASE}api/stt`, { method: 'POST', body: formData });
    if (!sttRes.ok) throw new Error(`STT failed: ${sttRes.statusText}`);
    const { text: userText } = await sttRes.json();

    if (!userText || userText.trim().length === 0) return;

    // Add user message with recorded audio
    const userAudioUrl = URL.createObjectURL(blob);
    messages.push({ role: 'user', text: userText, audioUrl: userAudioUrl, timestamp: Date.now() });
    pendingRequests++;
    render();

    // 2. Send to OpenClaw
    const sendBody: any = { message: userText };
    if (selectedSessionKey) sendBody.sessionKey = selectedSessionKey;

    const chatRes = await fetch(`${BASE}api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendBody),
    });

    if (!chatRes.ok) throw new Error(`Chat failed: ${chatRes.statusText}`);
    const { taskId } = await chatRes.json();
    soundSendSuccess();
    startThinkingSound();

    // 3. Wait for result via WebSocket
    const resultText = await waitForResult(taskId);
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

    // Add assistant message (autoplay handled by render)
    soundResponseReceived();
    messages.push({ role: 'assistant', text: resultText, audioUrl, timestamp: Date.now() });
  } catch (err: any) {
    console.error('Process error:', err);
    stopThinkingSound();
    soundError();
    messages.push({ role: 'assistant', text: `Error: ${err.message}`, timestamp: Date.now() });
  }

  pendingRequests = Math.max(0, pendingRequests - 1);
  render();
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
      // Audio will be auto-played via the rendered <audio> element below
    }
  } catch {}

  messages.push({ role: 'assistant', text: msg.text, audioUrl, timestamp: Date.now() });
  render();
}

async function resetSession() {
  await fetch(`${BASE}api/session/reset`, { method: 'POST' });
  messages = [];
  render();
}

// --- Init ---
connectWs();
render();

// Load history for default session on startup
selectSession(DEFAULT_SESSION);

// Keyboard shortcut: Space to toggle recording
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !recordingCooldown && document.activeElement?.tagName !== 'SELECT') {
    e.preventDefault();
    if (isRecording) stopRecording();
    else startRecording();
  }
});
