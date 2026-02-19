import './style.css';

const BASE = import.meta.env.BASE_URL;

interface Message {
  role: 'user' | 'assistant';
  text: string;
  audioUrl?: string;
  timestamp: number;
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
let isProcessing = false;
let selectedVoice = localStorage.getItem('openclaw-whisper-voice') || 'coral';
let autoPlayTTS = localStorage.getItem('openclaw-whisper-autoplay') !== 'false';
let sessions: Session[] = [];
let selectedSessionKey: string | null = null; // null = default whisper session
let sessionsLoading = false;
let showSessionPanel = false;

// --- Sessions ---
async function loadSessions() {
  sessionsLoading = true;
  render();
  try {
    const res = await fetch(`${BASE}api/sessions`);
    if (res.ok) {
      const data = await res.json();
      sessions = Array.isArray(data) ? data : (data.sessions || []);
    }
  } catch (e) {
    console.error('Failed to load sessions:', e);
  }
  sessionsLoading = false;
  render();
}

async function selectSession(sessionKey: string | null) {
  selectedSessionKey = sessionKey;
  messages = [];
  render();

  if (sessionKey) {
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
  }
  showSessionPanel = false;
  render();
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
        📋 ${selectedSessionKey ? getSessionLabel({ sessionKey: selectedSessionKey }) : 'Default Session'}
        <span class="caret">▾</span>
      </button>
    </div>
    ${showSessionPanel ? `
    <div class="session-panel" id="sessionPanel">
      <div class="session-panel-header">
        <span>Sessions</span>
        <button class="session-refresh-btn" id="sessionRefreshBtn">🔄</button>
      </div>
      <div class="session-list">
        <button class="session-item ${selectedSessionKey === null ? 'active' : ''}" data-key="">
          🎙️ Default (Whisper Voice)
        </button>
        ${sessionsLoading ? '<div class="session-loading"><div class="spinner"></div> Loading...</div>' : ''}
        ${sessions.map(s => `
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
          <div class="bubble">${escapeHtml(m.text)}</div>
          ${m.audioUrl ? `<audio controls src="${m.audioUrl}" preload="none"></audio>` : ''}
          <div class="meta">${new Date(m.timestamp).toLocaleTimeString()}</div>
        </div>
      `).join('')}
      ${isProcessing ? `
        <div class="message assistant">
          <div class="thinking"><div class="spinner"></div> Thinking...</div>
        </div>
      ` : ''}
    </div>
    <div class="controls">
      <div class="controls-row">
        <button class="ptt-btn ${isRecording ? 'recording' : ''}" id="pttBtn" ${isProcessing ? 'disabled' : ''}>
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
        <button class="btn ${autoPlayTTS ? 'active' : ''}" id="autoPlayBtn">🔊 Auto-play</button>
        <button class="btn" id="resetBtn">🔄 New Session</button>
      </div>
    </div>
  `;

  // Scroll to bottom
  const conv = document.getElementById('conversation')!;
  conv.scrollTop = conv.scrollHeight;

  // Bind events
  bindEvents();
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

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bindEvents() {
  const pttBtn = document.getElementById('pttBtn')!;
  const voiceSelect = document.getElementById('voiceSelect') as HTMLSelectElement;
  const autoPlayBtn = document.getElementById('autoPlayBtn')!;
  const resetBtn = document.getElementById('resetBtn')!;
  const sessionToggleBtn = document.getElementById('sessionToggleBtn');
  const sessionRefreshBtn = document.getElementById('sessionRefreshBtn');

  // Tap to toggle recording
  const toggleRec = (e: Event) => {
    e.preventDefault();
    if (isProcessing) return;
    if (isRecording) stopRecording();
    else startRecording();
  };

  pttBtn.addEventListener('click', toggleRec);
  pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); toggleRec(e); });

  voiceSelect.addEventListener('change', () => { selectedVoice = voiceSelect.value; localStorage.setItem('openclaw-whisper-voice', selectedVoice); });
  autoPlayBtn.addEventListener('click', () => { autoPlayTTS = !autoPlayTTS; localStorage.setItem('openclaw-whisper-autoplay', String(autoPlayTTS)); render(); });
  resetBtn.addEventListener('click', resetSession);

  // Session panel toggle
  sessionToggleBtn?.addEventListener('click', () => {
    showSessionPanel = !showSessionPanel;
    if (showSessionPanel && sessions.length === 0) loadSessions();
    else render();
  });

  sessionRefreshBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    loadSessions();
  });

  // Session item clicks
  document.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => {
      const key = (el as HTMLElement).dataset.key || '';
      selectSession(key || null);
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
    mediaRecorder.stop();
  }
  isRecording = false;
  render();
}

async function processRecording() {
  const duration = Date.now() - recordingStartTime;
  if (audioChunks.length === 0 || duration < 300) return; // min 300ms
  isProcessing = true;
  render();

  try {
    // 1. Send audio to Whisper STT
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');

    const sttRes = await fetch(`${BASE}api/stt`, { method: 'POST', body: formData });
    if (!sttRes.ok) throw new Error(`STT failed: ${sttRes.statusText}`);
    const { text: userText } = await sttRes.json();

    if (!userText || userText.trim().length === 0) {
      isProcessing = false;
      render();
      return;
    }

    // Add user message with recorded audio
    const userAudioUrl = URL.createObjectURL(blob);
    messages.push({ role: 'user', text: userText, audioUrl: userAudioUrl, timestamp: Date.now() });
    render();

    // 2. Send to OpenClaw (include sessionKey if selected)
    const sendBody: any = { message: userText };
    if (selectedSessionKey) sendBody.sessionKey = selectedSessionKey;

    const chatRes = await fetch(`${BASE}api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendBody),
    });

    if (!chatRes.ok) throw new Error(`Chat failed: ${chatRes.statusText}`);
    const { taskId } = await chatRes.json();

    // 3. Wait for result via WebSocket
    const resultText = await waitForResult(taskId);

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
        if (autoPlayTTS) {
          const audio = new Audio(audioUrl);
          audio.play().catch(() => {});
        }
      }
    } catch (e) {
      console.warn('TTS failed:', e);
    }

    // Add assistant message
    messages.push({ role: 'assistant', text: resultText, audioUrl, timestamp: Date.now() });
  } catch (err: any) {
    console.error('Process error:', err);
    messages.push({ role: 'assistant', text: `Error: ${err.message}`, timestamp: Date.now() });
  }

  isProcessing = false;
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
      if (msg.type === 'result' && !isProcessing) {
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
      if (autoPlayTTS) new Audio(audioUrl).play().catch(() => {});
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
(async () => {
  try {
    const res = await fetch(`${BASE}api/sessions/whisper-voice:ET/history`);
    if (res.ok) {
      const data = await res.json();
      const hist = Array.isArray(data) ? data : (data.messages || []);
      if (hist.length > 0 && messages.length === 0 && !selectedSessionKey) {
        messages = hist.map((m: any) => ({
          role: m.role === 'user' || m.sender === 'user' ? 'user' as const : 'assistant' as const,
          text: extractText(m.text || m.content || m.message || ''),
          timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
        }));
        render();
      }
    }
  } catch (e) { console.error('Failed to load default history:', e); }
})();

// Keyboard shortcut: Space to toggle recording
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !isProcessing && document.activeElement?.tagName !== 'SELECT') {
    e.preventDefault();
    if (isRecording) stopRecording();
    else startRecording();
  }
});
