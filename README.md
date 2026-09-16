# muse-Jarvis

Discord voice interface for a personal assistant. A deliberately dumb pipe:
it hears, transcribes, queues, and speaks. All judgment lives elsewhere.

## What it does

- Joins a Discord voice channel and follows the owner between channels.
- Transcribes speech (wake phrase `jarvis`, 30s follow-up window) via
  faster-whisper, pushes utterances to an in-memory outbox.
- Serves the outbox at `GET /voice-inbox` (Bearer auth, cursor-based,
  exactly-once) and speaks replies via `POST /speak` (Chatterbox TTS).
- Typed owner input (bot DMs, #general, voice-channel chat) is queued the
  same way, tagged `via: 'text'`, and answered in text via
  `POST /send-text`. Text in, text out.
- When the owner isn't in voice, spoken replies fall back to text: his live
  voice channel's chat, then the configured main channel, then DM.

## What it doesn't do

No conversational model, no tools, no decisions. It never answers on its
own — a separate worker drains the outbox and is the sole responder.

## Run

```bash
npm ci
cp .env.example .env   # fill in DISCORD_TOKEN, ALERT_WEBHOOK_TOKEN, ids
node src/index.js
```

Systemd user unit: `jarvis-voice.service`
(`WorkingDirectory` = this tree, `EnvironmentFile` = `.env`).

## Endpoints (all Bearer `ALERT_WEBHOOK_TOKEN` except /health)

- `GET /health` — liveness, outbox/player depth, STT/TTS health
- `GET /voice-inbox?since=<id>&wait=<s>` — long-pollable outbox
- `POST /speak {message}` — voice if the owner is in channel, else text fallback
- `POST /send-text {channelId, message}` — text reply to a channel
