# muse-Jarvis

We gave Muse a voice.

Muse is Meta's personal AI agent — it already does your work, remembers your
life, and keeps going after you close the app. This project adds ears and a
mouth: a Discord voice interface, so you can talk to your Muse out loud and
it talks back. That's the whole hack.

The bot itself is deliberately dumb: it hears, transcribes, queues, and
speaks. All the thinking is Muse — your persistent agent session, with tools,
memory, and judgment. One mind, dumb edges.

## Play with it first

The fastest way to hear it talk takes about ten minutes. You don't even need
a microphone or a GPU to start — the bot has a test endpoint that injects a
fake utterance, so you can watch the whole loop work end to end.

**1. Get a Discord bot token** (5 minutes, free): in the
[Discord developer portal](https://discord.com/developers/applications),
create an application → Bot → copy the token → OAuth2 URL Generator →
scope `bot` → open the URL and add it to your server. Then under
Bot → Privileged Gateway Intents, enable **Message Content Intent**
(typed messages need it).

**2. Run the bot:**

```bash
git clone https://github.com/lancejames221b/muse-Jarvis.git
cd muse-Jarvis
npm ci
cp .env.example .env   # fill in DISCORD_TOKEN + a long random ALERT_WEBHOOK_TOKEN
node src/index.js
# or: node src/index.js --check-config   (validates .env without connecting)
```

Requires **Node ≥ 24** and a C++ toolchain for the native `@discordjs/opus`
module (`python3`, `make`, `g++` — e.g. `build-essential` on Debian/Ubuntu).

**3. Run a brain.** The quick smoke test is `examples/minimal-brain.py` —
80 lines of stdlib-only Python that answers through any OpenAI-compatible
chat endpoint:

```bash
export JARVIS_LLM_URL=http://your-llm:1234/v1/chat/completions
export JARVIS_LLM_MODEL=your-model
# export JARVIS_LLM_KEY=...   # only if your endpoint needs one
python3 examples/minimal-brain.py
```

That's a stand-in to prove the loop works. The real brain is a persistent
**Muse** agent session: it polls the outbox, decides per utterance whether to
answer now, work in the background, or stay silent, and replies through
`/speak` — with tools, memory, and judgment. The agent that builds the
system is the mind that runs it.

**4. Fake an utterance** — no mic needed:

```bash
curl -X POST http://localhost:3335/voice-inbox/test \
  -H "Authorization: Bearer YOUR_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Jarvis, say hello"}'
```

The brain answers through `/speak` — out loud if you're in the voice
channel, as text where you'll see it if you're not. That's the whole loop.
Everything after this is making the voice real and the brain smarter.

## Make it real

- **Speech.** Self-host [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
  (STT) and [Chatterbox](https://github.com/resemble-ai/chatterbox) (TTS, cloned
  voice) — or anything that implements the two HTTP contracts in
  `docs/speech-services.md`. A reference faster-whisper server is
  `examples/stt-server.py`; the TTS side is any Chatterbox HTTP wrapper
  exposing the `/tts` contract.
- **Network.** Put your machines on [Tailscale](https://tailscale.com) first.
  Nothing you run should listen on the public internet — that's the security
  model, and it's the whole reason this is safe to run.
- **Brain.** The real brain is a persistent [Muse](https://muse.ai) agent
  session — `docs/muse-brain.md` has the loop, the behavior rules, and a
  paste-ready operator brief to turn your Muse into the mind.
  `examples/minimal-brain.py` is the 80-line stand-in for smoke-testing.
  The contract never changes: poll the queue, answer through `/speak`.

The full guide — parts list, setup steps, the three-endpoint contract:
`docs/how-to-make-a-jarvis.md`.

## How it works

```
 your voice
     │
     ▼
┌──────────┐  audio   ┌──────────┐  wav   ┌─────┐  text  ┌──────────┐
│ Discord  │ ───────▶  │   bot    │ ─────▶ │ STT │ ─────▶ │  outbox  │ ◀── poll ── brain
│  voice   │          │  (dumb   │        │     │        │ /voice-   │     (you)
│ channel  │ ◀───────  │  pipe)   │ ◀───── │ TTS │ ◀───── │  inbox   │
└──────────┘  audio   └──────────┘  wav   └─────┘  text  └──────────┘
                                    ▲  /speak · /send-text
```

- Say **"Jarvis"** once → ~30s follow-up window, just keep talking.
  "That's all" / "thanks" closes it.
- **Silence by default.** The mic hears everything — conversations, phone
  calls, humming. Only clearly-addressed speech is ever answered.
- **Transcript ticker.** Every utterance accepted as addressed to Jarvis is
  posted to the voice channel's text chat, so you can see you're heard.
  Disable with `JARVIS_TRANSCRIPT_FEED=false`.
- **Reply mirror.** Every spoken reply is mirrored as text in the voice
  channel's chat — the Discord record is complete: what you said, what
  Jarvis said back. Text fallback already posts text, so it is never
  duplicated.
- **Typed input** works in every channel and thread the bot can see. DMs and
  the voice-channel chat are implicitly addressed; everywhere else @-mention
  the bot or lead with "jarvis". It enters the same queue tagged
  `via: 'text'` and gets text replies via `/send-text` to the exact
  originating channel. Text in, text out — never voice playback for typed
  messages.
- When you aren't in voice, spoken replies degrade gracefully to text that
  *follows you*: your live channel's chat, then the main channel, then DM.

## What it doesn't do

No conversational model, no tools, no decisions. It never answers on its own —
your Muse drains the outbox and is the sole responder. If the bot ever seems
smart, that's Muse, not the bot.

## Endpoints

All Bearer-guarded with `ALERT_WEBHOOK_TOKEN` (except `/health`).

| Endpoint | What it does |
|---|---|
| `GET /health` | Liveness, outbox/player depth, STT/TTS health |
| `GET /voice-inbox?since=<id>&wait=<s>` | Long-pollable outbox; cursor-based, no-duplicate best-effort delivery |
| `POST /speak {message}` | Voice if you're in the channel, else text fallback |
| `POST /send-text {channelId, message}` | Text reply to a typed message, in its channel |
| `POST /voice-inbox/test {text}` | Inject a synthetic utterance (no-mic smoke test) |

`TEXT_ENABLED` (default `true`) gates typed input and `/send-text`;
`POST /send-text` returns 409 while off.

`JARVIS_FOLLOW_USER_VOICE` (default `true`): when `true` the bot follows the owner
across voice channels; set to `false` to pin it in its current channel (it will not
trail you when you switch channels).

## Docs

- `docs/how-to-make-a-jarvis.md` — the build guide: parts, steps, contract.
- `docs/muse-brain.md` — run the brain as a persistent Muse agent session:
  the loop, behavior rules, and a paste-ready operator brief.
- `docs/speech-services.md` — the exact STT/TTS HTTP contracts.
- `docs/dead-zeppelin.md` — the design essay: personal agentic AI, the
  Tailscale security model, and why dumb pipes win.
- `examples/` — `minimal-brain.py` (80-line brain), `stt-server.py`
  (reference faster-whisper server), `jarvis-voice.service` (systemd template).

## Acknowledgments

Built on [discord.js](https://discord.js.org),
[faster-whisper](https://github.com/SYSTRAN/faster-whisper),
[Chatterbox](https://github.com/resemble-ai/chatterbox),
[Tailscale](https://tailscale.com), and [Muse](https://muse.ai).
The dumb-pipe idea is old; the network that makes it safe is new.

---

MIT — see [LICENSE](LICENSE). If this makes you smile, a ⭐ is the cheapest
way to say thanks.
