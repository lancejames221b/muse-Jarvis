# muse-Jarvis

Discord voice interface for a personal assistant. A deliberately dumb pipe:
it hears, transcribes, queues, and speaks. All judgment lives elsewhere.

## What it does

- Joins a Discord voice channel and follows the owner between channels.
- Transcribes speech (wake phrase `jarvis`, 30s follow-up window) via
  faster-whisper, pushes utterances to an in-memory outbox.
- Serves the outbox at `GET /voice-inbox` (Bearer auth, cursor-based,
  no-duplicates, best-effort in-memory ring) and speaks replies via
  `POST /speak` (Chatterbox TTS).
- Typed owner input (bot DMs, #general, voice-channel chat) is queued the
  same way, tagged `via: 'text'`, and answered in text via
  `POST /send-text`. Text in, text out.
- When the owner isn't in voice, spoken replies fall back to text: his live
  voice channel's chat, then the configured main channel, then DM.

## What it doesn't do

No conversational model, no tools, no decisions. It never answers on its
own — a separate worker drains the outbox and is the sole responder.

## Run

Requires **Node ≥ 24** and a C++ toolchain for the native `@discordjs/opus`
module (`python3`, `make`, `g++` — e.g. `build-essential` on Debian/Ubuntu).

```bash
npm ci
cp .env.example .env   # fill in DISCORD_TOKEN, ALERT_WEBHOOK_TOKEN, ids
node src/index.js
# or: npm start        (same thing)
```

Design write-up (the Dead Zeppelin post — personal agentic AI, Tailscale security, replication guide):
`docs/dead-zeppelin.md`.

Systemd user unit template: `examples/jarvis-voice.service`
(`WorkingDirectory` = this tree, `EnvironmentFile` = `.env`).

## Build your own

Simple guide: `docs/how-to-make-a-jarvis.md` — parts list, setup steps,
and the three-endpoint contract. Includes `examples/minimal-brain.py`,
an 80-line stdlib-only brain to start from.

## Endpoints (all Bearer `ALERT_WEBHOOK_TOKEN` except /health)

`TEXT_ENABLED` (default true) gates typed input and `/send-text`.
`POST /send-text` returns 409 while it is off. `/speak` keeps its
text fallback when you are not in voice.

- `GET /health` — liveness, outbox/player depth, STT/TTS health
- `GET /voice-inbox?since=<id>&wait=<s>` — long-pollable outbox
- `POST /speak {message}` — voice if the owner is in channel, else text fallback
- `POST /send-text {channelId, message}` — text reply to a channel
