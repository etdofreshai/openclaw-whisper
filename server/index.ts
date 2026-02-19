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
const SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || 'whisper-voice:ET';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

function handleGatewayMessage(message: any): void {
  if (message.type === 'event' && (message.event === 'tick' || message.event === 'health')) return;

  if (message.type === 'event' && message.event === 'connect.challenge') {
    const nonce = message.payload?.nonce;
    if (nonce && gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
      gatewayWs.send(JSON.stringify({
        type: 'req', id: `connect_${Date.now()}`, method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'openclaw-whisper', version: '1.0.0', platform: 'linux', mode: 'backend' },
          role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'],
          caps: [],
          auth: { token: GATEWAY_TOKEN }
        }
      }));
    }
    return;
  }

  if (message.type === 'res' && message.ok && message.payload?.type === 'hello-ok') {
    console.log('Gateway handshake complete:', JSON.stringify(message.payload).slice(0, 500));
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

// Send message to OpenClaw (async, result comes via WebSocket)
app.post('/api/send', async (req, res) => {
  try {
    const { message, sessionKey: targetSessionKey } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
      return res.status(503).json({ error: 'Gateway not connected' });
    }

    const requestId = generateRequestId();
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    activeRuns.set(requestId, { taskId, text: '' });

    const sessionKey = targetSessionKey || getSessionKey();
    gatewayWs.send(JSON.stringify({
      type: 'req', id: requestId, method: 'chat.send',
      params: { sessionKey, message, idempotencyKey: requestId }
    }));

    // Handle the initial response
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
    }, 120000);
    pendingRequests.set(requestId, {
      resolve: () => {},
      reject: () => {},
      timeout,
    });

    res.json({ taskId });
  } catch (err: any) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sessions list
app.get('/api/sessions', async (_req, res) => {
  try {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
      return res.status(503).json({ error: 'Gateway not connected' });
    }
    const requestId = generateRequestId();
    const result = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { pendingRequests.delete(requestId); reject(new Error('Timeout')); }, 15000);
      pendingRequests.set(requestId, { resolve, reject, timeout });
      const msg = JSON.stringify({
        type: 'req', id: requestId, method: 'sessions.list',
        params: { limit: 50, includeGlobal: true }
      });
      console.log('Sending sessions.list:', msg);
      gatewayWs!.send(msg);
    });
    console.log('Sessions list result:', JSON.stringify(result).slice(0, 500));
    res.json(result);
  } catch (err: any) {
    console.error('Sessions list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Session history
app.get('/api/sessions/:sessionKey/history', async (req, res) => {
  try {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
      return res.status(503).json({ error: 'Gateway not connected' });
    }
    const { sessionKey } = req.params;
    const requestId = generateRequestId();
    const result = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { pendingRequests.delete(requestId); reject(new Error('Timeout')); }, 15000);
      pendingRequests.set(requestId, { resolve, reject, timeout });
      gatewayWs!.send(JSON.stringify({
        type: 'req', id: requestId, method: 'chat.history',
        params: { sessionKey, limit: 50 }
      }));
    });
    res.json(result);
  } catch (err: any) {
    console.error('Session history error:', err);
    res.status(500).json({ error: err.message });
  }
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
