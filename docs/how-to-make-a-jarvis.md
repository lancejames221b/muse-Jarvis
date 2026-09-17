# How to make a Jarvis using Muse

A voice assistant you talk to in Discord: you speak, it answers out loud.
The bot itself is deliberately dumb — all the thinking happens in an agent
(the same kind of Muse session that's writing this). An evening's work if
you've got the parts.

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
  cloned voice) on a GPU box. Or use any STT/TTS API — the bot only needs
  their HTTP URLs.
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
if you want them) → open the URL, add it to your server. Also enable the
`MESSAGE CONTENT` intent if you want typed chat.

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

**4. Run the bot.**

```bash
node src/index.js
# or: node src/index.js --check-config   (validates .env without connecting)
```

It logs in, joins your voice channel, and starts serving its API on
`ALERT_WEBHOOK_PORT` (default 3335).

**5. Run the brain.** The bot exposes three endpoints (Bearer auth with your
webhook token):

- `GET /voice-inbox?since=<id>&wait=45` → new utterances since your cursor
  (`[{id, ts, text, followUp?, via?, channelId?}]`). Hold the cursor in a
  file; one poller owns it — that's your exactly-once delivery.
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
python3 examples/minimal-brain.py
```

That's it — a talking assistant. The production version of the brain is a
persistent Muse agent: it classifies (answer now / work in background / stay
silent), uses tools, and keeps a transcript ledger. But the contract never
changes: poll the queue, answer through `/speak`.

**6. Talk.** Join the voice channel, say "Jarvis" — it answers. Say it once,
then just keep talking for ~30 seconds (the follow-up window). Say "that's
all" or "thanks" to close it. Or just type to it in a DM or channel.

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
