# How to make a Jarvis using Muse

We gave Muse a voice. A voice assistant you talk to in Discord: you speak,
your Muse answers out loud. The bot itself is deliberately dumb — all the
thinking happens in your Muse agent session (the same kind of session that's
writing this). An evening's work if you've got the parts.

## What you're building

Three pieces, connected by plain HTTP:

1. **The bot** (this repo) — joins your Discord voice channel, turns speech
   into text, and speaks replies. No model, no decisions.
2. **Speech services** — one turns voice into text (STT), one turns text into
   voice (TTS).
3. **The brain** — a loop that reads new utterances and answers them. The
   simplest brain is 80 lines of Python (see `examples/minimal-brain.py`);
   the full version is a persistent Muse agent session with tools, memory,
   and judgment.

## What you need

- A computer that's always on — a spare box, mini PC, or VM. It runs the bot.
- A Discord server where you're admin, and a **bot token** (free — 5 minutes
  in the [Discord developer portal](https://discord.com/developers/applications),
  create an app, add a bot, copy the token, invite it with voice permissions).
- Speech: we self-host **faster-whisper** (STT) and **Chatterbox** (TTS,
  cloned voice) on a GPU box. Or use any STT/TTS service that implements the
  two contracts in `docs/speech-services.md` — the bot needs those exact HTTP
  shapes, not just any API.
- Build tools: **Node ≥ 24** and a C++ toolchain for the native
  `@discordjs/opus` module (`python3`, `make`, `g++` — e.g.
  `build-essential` on Debian/Ubuntu).
- **Tailscale** (free): puts your machines and your phone on a private
  network. Nothing you run is exposed to the public internet. Do this first —
  it's the security model.
- Somewhere to run the brain: any machine that can reach the bot over HTTP.

## Steps

**1. Tailscale.** Install it on your server and your phone, join the same
tailnet. Confirm they can reach each other. Done — that's your secure
network.

**2. Discord token.** In the developer portal: new application → Bot →
copy token → OAuth2 URL generator → scopes `bot` (+ `applications.commands`
if you want them) → open the URL, add it to your server. Then under
Bot → Privileged Gateway Intents, enable **Message Content Intent** —
without it, typed messages arrive with empty content and text input
silently does nothing.

**3. Clone and configure.**

```bash
git clone https://github.com/lancejames221b/muse-Jarvis.git
cd muse-Jarvis
npm ci
cp .env.example .env
```

Fill in `.env`: your `DISCORD_TOKEN`, guild/user/channel IDs (enable
Developer Mode in Discord → right-click → Copy ID), a long random
`ALERT_WEBHOOK_TOKEN`, and your `STT_URL` / `CHATTERBOX_URL`.

**4. Stand up speech services.** Before starting the bot, get STT and TTS
answering on HTTP. See `docs/speech-services.md` for both contracts and a
reference STT server (`examples/stt-server.py`). Verify with curl:

```bash
curl -X POST -F "audio=@test.wav;type=audio/wav" "$STT_URL"   # → {"text": "..."}
curl -X POST "$CHATTERBOX_URL/tts" \
  -H 'Content-Type: application/json' \
  -d '{"text":"test","voice":"your-voice"}' -o /dev/null -w '%{http_code}\n'  # → 200
```

Both must answer before the bot will start — `STT_URL` and
`CHATTERBOX_URL` are required at startup (`--check-config` validates config,
not reachability; curl does).

**5. Run the bot.**

```bash
node src/index.js
# or: node src/index.js --check-config   (validates .env without connecting)
```

It logs in, joins your voice channel, and starts serving its API on
`ALERT_WEBHOOK_PORT` (default 3335).

**6. Run the brain.** The bot exposes three endpoints (Bearer auth with your
webhook token):

- `GET /voice-inbox?since=<id>&wait=45` → new utterances since your cursor
  (`[{id, ts, text, followUp?, via?, channelId?}]`). Hold the cursor in a
  file; one poller owns it — that's your no-duplicate delivery (best-effort:
  in-memory ring of the last 50 items, cleared on bot restart).
- `POST /speak` `{"message": "..."}` → speaks it if you're in voice,
  otherwise posts it as text where you'll see it.
- `POST /send-text` `{"channelId": "...", "message": "..."}` → replies to a
  typed message in its channel.

The minimal version:

```bash
export JARVIS_BOT_URL=http://your-server:3335
export JARVIS_WEBHOOK_TOKEN=your_long_random_string
export JARVIS_LLM_URL=http://your-llm:1234/v1/chat/completions
export JARVIS_LLM_MODEL=your-model
export JARVIS_LLM_KEY=<your-llm-api-key>   # only if your endpoint needs one
python3 examples/minimal-brain.py
```

No-microphone smoke test: `POST /voice-inbox/test` (same Bearer <redacted>)
injects a synthetic utterance into the outbox, so you can verify the whole
brain round-trip before ever joining a voice channel.

That's it — a talking assistant. The production version of the brain is a
persistent Muse agent: it classifies (answer now / work in background / stay
silent), uses tools, and keeps a transcript ledger. Full operator setup —
the loop, behavior rules, and a paste-ready brief — is in
`docs/muse-brain.md`. But the contract never changes: poll the queue, answer
through `/speak`.

**7. Talk.** Join the voice channel, say "Jarvis" — it answers. Say it once,
then just keep talking for ~30 seconds (the follow-up window). Say "that's
all" or "thanks" to close it. Or type to it, in any channel or thread: DMs and the voice
channel's chat need no prefix; everywhere else @-mention the bot
or lead with "jarvis". (Set `TEXT_ENABLED=false` to run voice-only.)

## How it works, in 30 seconds

Your voice → Discord → bot → faster-whisper → text lands in the outbox →
your brain polls it, thinks, and POSTs a reply → Chatterbox synthesizes it →
bot plays it into the channel (muting you while it speaks so there's no
echo). The bot never decides anything; every smart behavior lives in the
brain, in exactly one place.

## Make it yours

- **Wake word and voice:** `JARVIS_LISTEN_WINDOW_MS`, `CHATTERBOX_VOICE`.
- **Who it trusts:** `ALLOWED_USERS` — start with just you.
- **Give the brain tools:** the minimal brain just chats. A real agent brain
  can run code, hit APIs, and do work while you keep talking.
- **Teach it manners:** the reference brain stays silent unless clearly
  addressed — a mic hears everything, and a voice assistant that interrupts
  is a surveillance device with manners.

Start simple, keep the queue boring, and grow the brain. The bot won't need
to change.
