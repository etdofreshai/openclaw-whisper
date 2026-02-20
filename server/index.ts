import express from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';

dotenv.config();

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || '3001');
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'wss://openclaw.etdofresh.com';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const SESSION_KEY_RAW = process.env.OPENCLAW_SESSION_KEY || 'whisper-voice:ET';
const SESSION_KEY = SESSION_KEY_RAW.startsWith('agent:') ? SESSION_KEY_RAW : `agent:main:${SESSION_KEY_RAW}`;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Server-side message history ---
interface HistoryMessage { role: 'user' | 'assistant'; text: string; timestamp: number; }
const HISTORY_FILE = path.join(os.tmpdir(), 'openclaw-whisper-history.json');

function loadHistory(): HistoryMessage[] {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch { return []; }
}
function saveHistory(messages: HistoryMessage[]) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(messages)); } catch (e) { console.error('Save history error:', e); }
}
function appendHistory(msg: HistoryMessage) {
  const msgs = loadHistory();
  msgs.push(msg);
  // Keep last 200 messages
  if (msgs.length > 200) msgs.splice(0, msgs.length - 200);
  saveHistory(msgs);
}

// --- Gateway connection ---
let gatewayWs: WebSocket | null = null;
let isConnecting = false;
let sessionKeySuffix = 0;

function getSessionKey(): string {
  return sessionKeySuffix === 0 ? SESSION_KEY : `${SESSION_KEY}:${sessionKeySuffix}`;
}

interface PendingRequest {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}
const pendingRequests = new Map<string, PendingRequest>();

interface ActiveRun { taskId: string; text: string; }
const activeRuns = new Map<string, ActiveRun>();

// WebSocket clients for push notifications
const wsClients = new Set<WebSocket>();

function broadcastToClients(msg: any) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function connectToGateway(): void {
  if (isConnecting || (gatewayWs && gatewayWs.readyState === WebSocket.OPEN)) return;
  isConnecting = true;
  console.log(`Connecting to OpenClaw gateway at ${GATEWAY_URL}...`);
  console.log(`  GATEWAY_TOKEN: ${GATEWAY_TOKEN ? `${GATEWAY_TOKEN.slice(0, 4)}...${GATEWAY_TOKEN.slice(-4)}` : '(not set)'}`);
  console.log(`  OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'set' : '(not set)'}`);

  try {
    gatewayWs = new WebSocket(GATEWAY_URL, { headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` } });

    gatewayWs.on('open', () => {
      console.log('Connected to OpenClaw gateway');
      isConnecting = false;
    });

    gatewayWs.on('message', (data: Buffer) => {
      try { handleGatewayMessage(JSON.parse(data.toString())); }
      catch (err) { console.error('Error parsing gateway message:', err); }
    });

    gatewayWs.on('error', (error) => { console.error('Gateway error:', error); isConnecting = false; });
    gatewayWs.on('close', (code: number, reason: Buffer) => {
      console.log(`Gateway closed (code: ${code}, reason: ${reason.toString()}), reconnecting...`);
      gatewayWs = null;
      isConnecting = false;
      setTimeout(connectToGateway, 5000);
    });
  } catch (error) {
    console.error('Error connecting to gateway:', error);
    isConnecting = false;
    setTimeout(connectToGateway, 5000);
  }
}

function fetchGatewayHistory(): void {
  if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) return;
  // Only fetch if we have no local history
  const existing = loadHistory();
  if (existing.length > 0) { console.log(`Local history has ${existing.length} messages, skipping gateway fetch`); return; }
  
  const requestId = `history_${Date.now()}`;
  const timeout = setTimeout(() => { pendingRequests.delete(requestId); console.log('History fetch timed out'); }, 15000);
  pendingRequests.set(requestId, {
    resolve: (result: any) => {
      try {
        const messages = result?.messages || result?.lastMessages || [];
        console.log(`Gateway history: got ${messages.length} messages`);
        const history: HistoryMessage[] = [];
        for (const m of messages) {
          const role = m.role === 'assistant' ? 'assistant' as const : 'user' as const;
          const text = typeof m.content === 'string' ? m.content : 
            Array.isArray(m.content) ? m.content.map((c: any) => c?.text || '').filter(Boolean).join('\n') :
            m.content?.text || String(m.content || '');
          if (!text) continue;
          history.push({ role, text, timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now() });
        }
        if (history.length > 0) saveHistory(history);
      } catch (e) { console.error('Error processing gateway history:', e); }
    },
    reject: (err: Error) => { console.error('Gateway history fetch failed:', err.message); },
    timeout,
  });
  gatewayWs!.send(JSON.stringify({
    type: 'req', id: requestId, method: 'sessions.preview',
    params: { sessionKey: getSessionKey(), messageLimit: 100 }
  }));
}

function handleGatewayMessage(message: any): void {
  if (message.type === 'event' && (message.event === 'tick' || message.event === 'health')) return;
  console.log(`GW msg: type=${message.type} event=${message.event||''} id=${message.id||''} ok=${message.ok} err=${message.error ? JSON.stringify(message.error).slice(0,200) : ''}`);

  if (message.type === 'event' && message.event === 'connect.challenge') {
    const nonce = message.payload?.nonce;
    if (nonce && gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
      gatewayWs.send(JSON.stringify({
        type: 'req', id: `connect_${Date.now()}`, method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'openclaw-control-ui', version: '1.0.0', platform: 'linux', mode: 'ui' },
          role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'],
          caps: [],
          auth: { token: GATEWAY_TOKEN }
        }
      }));
    }
    return;
  }

  if (message.type === 'res' && message.ok && message.payload?.type === 'hello-ok') {
    console.log('Gateway handshake complete:', JSON.stringify(message.payload).slice(0, 1500));
    // Fetch history on connect
    fetchGatewayHistory();
  }

  // Handle response to our requests
  if (message.id && pendingRequests.has(message.id)) {
    const pending = pendingRequests.get(message.id)!;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(typeof message.error === 'string' ? message.error : message.error.message || JSON.stringify(message.error)));
    } else {
      const result = message.result || message.payload;
      console.log(`Request resolved: id=${message.id} result=${JSON.stringify(result).slice(0, 200)}`);
      if (result?.runId && activeRuns.has(message.id)) {
        const run = activeRuns.get(message.id)!;
        activeRuns.delete(message.id);
        activeRuns.set(result.runId, run);
      }
      pending.resolve(result || message.response || 'Request processed');
    }
    return;
  }

  // Handle agent streaming events
  if (message.type === 'event' && message.event === 'agent') {
    const { runId, stream, data, sessionKey } = message.payload || {};
    console.log(`Agent event: stream=${stream} phase=${data?.phase} runId=${runId} sessionKey=${sessionKey} activeRuns=${[...activeRuns.keys()].join(',')}`);
    if (!runId) return;
    let run = activeRuns.get(runId);

    if (!run && sessionKey) {
      const normalizedKey = `agent:main:${getSessionKey().toLowerCase()}`;
      if (sessionKey === normalizedKey && stream === 'lifecycle' && data?.phase === 'start') {
        const taskId = `subtask_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        run = { taskId, text: '' };
        activeRuns.set(runId, run);
      }
    }
    if (!run) return;

    if (stream === 'assistant' && data?.text) { run.text = data.text; }
    else if (stream === 'lifecycle' && data?.phase === 'end') {
      broadcastToClients({ type: 'result', taskId: run.taskId, text: run.text || 'Task completed' });
      activeRuns.delete(runId);
    }
    return;
  }
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function sendToGateway(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) { reject(new Error('Gateway not connected')); return; }
    const requestId = generateRequestId();
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    activeRuns.set(requestId, { taskId, text: '' });

    const timeout = setTimeout(() => { pendingRequests.delete(requestId); reject(new Error('Gateway timeout')); }, 60000);
    pendingRequests.set(requestId, { resolve, reject, timeout });

    gatewayWs!.send(JSON.stringify({
      type: 'req', id: requestId, method: 'chat.send',
      params: { sessionKey: getSessionKey(), message, idempotencyKey: requestId }
    }));
  });
}

// --- Express app ---
const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Whisper STT
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file' });

    // Write to temp file (OpenAI SDK needs a file)
    const tmpPath = path.join(os.tmpdir(), `whisper_${Date.now()}.webm`);
    fs.writeFileSync(tmpPath, req.file.buffer);

    try {
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: 'whisper-1',
      });
      res.json({ text: transcription.text });
    } finally {
      fs.unlinkSync(tmpPath);
    }
  } catch (err: any) {
    console.error('STT error:', err);
    res.status(500).json({ error: err.message });
  }
});

// TTS
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'coral' } = req.body;
    if (!text) return res.status(400).json({ error: 'No text' });

    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice as any,
      input: text,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': buffer.length.toString() });
    res.send(buffer);
  } catch (err: any) {
    console.error('TTS error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Chat - send message to OpenClaw and wait for response
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });

    // Send to gateway - response comes async via agent events
    const requestId = generateRequestId();
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    activeRuns.set(requestId, { taskId, text: '' });

    // We'll wait for the result via a promise
    const result = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        // Check if we got a result via streaming
        const run = activeRuns.get(requestId);
        if (run && run.text) {
          activeRuns.delete(requestId);
          resolve(run.text);
        } else {
          reject(new Error('Timeout waiting for response'));
        }
      }, 120000);

      pendingRequests.set(requestId, { resolve, reject, timeout });

      gatewayWs!.send(JSON.stringify({
        type: 'req', id: requestId, method: 'chat.send',
        params: { sessionKey: getSessionKey(), message, idempotencyKey: requestId }
      }));
    });

    // The result from gateway is the initial ack; the actual text comes from agent events
    // We need to wait for the agent stream to finish
    // Actually, the result from chat.send returns quickly, then agent events stream in
    // Let's use a different approach: return taskId, client polls or uses WS

    res.json({ text: typeof result === 'string' ? result : JSON.stringify(result), taskId });
  } catch (err: any) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send message to OpenClaw via HTTP chat completions endpoint
app.post('/api/send', async (req, res) => {
  try {
    const { message, sessionKey: clientSessionKey } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });

    // Use client-provided session key if given, otherwise default
    const rawKey = clientSessionKey || getSessionKey();
    const sessionKey = rawKey.startsWith('agent:') ? rawKey : `agent:main:${rawKey}`;
    const gatewayHttpUrl = (process.env.OPENCLAW_GATEWAY_URL || 'ws://localhost:18789')
      .replace('wss://', 'https://').replace('ws://', 'http://');

    console.log(`Sending via HTTP: sessionKey=${sessionKey} url=${gatewayHttpUrl}/v1/chat/completions`);
    appendHistory({ role: 'user', text: message, timestamp: Date.now() });

    const response = await fetch(`${gatewayHttpUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'x-openclaw-session-key': sessionKey,
      },
      body: JSON.stringify({
        model: 'default',
        messages: [{ role: 'user', content: message }],
        stream: false,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`HTTP chat error: ${response.status} ${errText}`);
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json() as any;
    const assistantText = data.choices?.[0]?.message?.content || 'No response';
    console.log(`Got response: ${assistantText.slice(0, 100)}...`);
    appendHistory({ role: 'assistant', text: assistantText, timestamp: Date.now() });

    res.json({ text: assistantText });
  } catch (err: any) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List sessions
app.get('/api/sessions', async (_req, res) => {
  try {
    const gatewayHttpUrl = (process.env.OPENCLAW_GATEWAY_URL || 'ws://localhost:18789')
      .replace('wss://', 'https://').replace('ws://', 'http://');
    const response = await fetch(`${gatewayHttpUrl}/v1/sessions?messageLimit=1`, {
      headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
    });
    if (!response.ok) return res.status(response.status).json({ error: await response.text() });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    console.error('Sessions list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Session history
app.get('/api/sessions/:key/history', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const sessionKey = key.startsWith('agent:') ? key : `agent:main:${key}`;
    const gatewayHttpUrl = (process.env.OPENCLAW_GATEWAY_URL || 'ws://localhost:18789')
      .replace('wss://', 'https://').replace('ws://', 'http://');
    const response = await fetch(`${gatewayHttpUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/history?limit=50`, {
      headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
    });
    if (!response.ok) return res.status(response.status).json({ error: await response.text() });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    console.error('Session history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Chat history from server-side JSON file
app.get('/api/history', (_req, res) => {
  res.json({ messages: loadHistory() });
});

// Health
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    gatewayConnected: gatewayWs !== null && gatewayWs.readyState === WebSocket.OPEN,
    clients: wsClients.size,
  });
});

// Session reset
app.post('/api/session/reset', (_req, res) => {
  sessionKeySuffix++;
  activeRuns.clear();
  res.json({ status: 'ok', sessionKey: getSessionKey() });
});

// --- Serve static files (Vite build output) ---
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = join(__dirname, '..', '..', 'dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => { res.sendFile(join(distPath, 'index.html')); });

// --- Start server ---
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.send(JSON.stringify({ type: 'connected' }));
});

connectToGateway();

server.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
