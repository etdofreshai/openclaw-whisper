# OpenClaw Whisper Voice

Voice chat with OpenClaw using OpenAI Whisper STT + TTS. A simpler alternative to the Realtime API version — records audio, transcribes with Whisper, sends to OpenClaw, and speaks the response with OpenAI TTS.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your keys
npm run dev
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for Whisper + TTS |
| `OPENCLAW_GATEWAY_URL` | No | Gateway WebSocket URL (default: `wss://openclaw.etdofresh.com`) |
| `OPENCLAW_GATEWAY_TOKEN` | Yes | Gateway auth token |
| `OPENCLAW_SESSION_KEY` | No | Session key (default: `whisper-voice:ET`) |
| `BACKEND_PORT` | No | Backend port (default: 3001) |

## How It Works

1. **Push-to-talk**: Hold mic button (or spacebar) to record
2. **Whisper STT**: Audio sent to server → OpenAI Whisper → text
3. **OpenClaw**: Text sent to gateway → agent processes → response
4. **TTS**: Response text → OpenAI TTS → audio playback

## Architecture

```
Browser (MediaRecorder) → Server (/api/stt) → OpenAI Whisper
                                    ↓
                          OpenClaw Gateway → Agent (Claude)
                                    ↓
Browser (Audio playback) ← Server (/api/tts) ← OpenAI TTS
```

All API keys are server-side only. The browser never sees `OPENAI_API_KEY`.
