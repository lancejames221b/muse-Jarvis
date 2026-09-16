# How we gave an AI assistant a voice on Discord — built with Muse, inside Muse

Most voice assistants are monoliths: one app that hears, thinks, and speaks.
We split ours in three — ears, mind, mouth — joined by the dumbest protocols
we could get away with. And the engineer that designed and wrote the whole
thing is the same mind that now answers the calls. This is the full design,
so you can replicate it.

## The shape of the idea

A Discord bot lives in a voice channel. It has **no model, no tools, no
opinions**. It captures audio, transcribes it, puts the text in a queue, and —
when told — speaks text aloud. Everything resembling thought happens
elsewhere: in a persistent AI agent session (running on Meta's Muse) whose
only job is draining that queue and responding.

Dumb edges, one mind. The bot never decides anything, which means there is
exactly one place where behavior lives, one place to fix, one place to
improve. Every "smart" thing the system does — including writing its own
replacement — happened in the agent, not the bot.

## The pipeline, end to end

1. **Ears.** The bot (Node.js, discord.js) joins a voice channel and follows
   the owner between channels. Per-user Opus audio is decoded and streamed to
   **faster-whisper**, a self-hosted speech-to-text service.
2. **The gate.** Only utterances addressed to the assistant enter the
   pipeline. Saying the wake word once opens a ~30 second follow-up window —
   say the name, then just talk; it keeps listening until you close it
   ("that's all", "thanks") or go quiet. Humming, filler sounds, and
   background chatter never leave the bot.
3. **The outbox.** Matched utterances land in an in-memory outbox served over
   HTTP: `GET /voice-inbox?since=<cursor>` (Bearer auth, long-pollable).
   IDs are monotonic and persisted across restarts; the consumer holds the
   cursor. That pairing is the entire integration contract, and it gives
   exactly-once delivery with no shared database.
4. **The poller.** A tiny daemon — the *only* owner of the cursor — drains the
   outbox into a queue file and logs both directions of the conversation to a
   shared transcript ledger, so any session can pick up the thread.
5. **The mind.** A persistent agent session reads each item and does the one
   thing the bot cannot: judge. Answer now, work in the background, or stay
   silent. Replies go back over HTTP via `POST /speak`.
6. **The mouth.** **Chatterbox**, a self-hosted TTS service running a cloned
   voice, synthesizes the reply; the bot plays it into the channel,
   server-muting the user while it speaks so the mic doesn't echo it back.
7. **The text shadow.** A parallel path handles typed messages — DMs to the
   bot, a main text channel, the voice channel's own chat. They enter the same
   queue tagged as text and get text replies (`POST /send-text`). And when the
   user isn't in voice at all, spoken replies degrade gracefully to text that
   *follows them*: their live voice channel's chat first, then the main
   channel, then DM.

## Five decisions that mattered

**1. The bot is not allowed to think.** Ripping the conversational model out
of the bot was the single best decision. Latency dropped, behavior became
consistent, and debugging turned into reading one log instead of three.

**2. Silence is the default.** The microphone hears everything — real
conversations, phone calls, humming. The pipeline treats all captured speech
as *not addressed to the assistant* unless it clearly is. A voice interface
that interrupts is a surveillance device with manners; ours stays quiet
unless spoken to.

**3. The queue is the API.** No SDK, no shared memory, no framework. HTTP +
cursor + Bearer token. Either end can be rewritten, moved, or replaced
without touching the other — which is exactly what happened: the entire bot
was rewritten from scratch mid-project and the agent side never noticed.

**4. Text tracks voice.** The moment the system could write as well as speak,
the question became *where*. Answer: wherever the user is. The fallback chain
(voice-channel chat → main channel → DM) means a reply never gets lost and
never spams.

**5. Operations are runbooks, not memory.** Every procedure — cutover,
rollback, restarts, diagnosing the tunnel — got written down as a short
skill: a markdown file any session can read and follow. The system is
operable by an agent that has never seen it before, because the knowledge
isn't in anyone's head.

## Replicate it

You need: a Discord application and bot token; a machine with a GPU for the
STT/TTS services (or hosted equivalents behind the same HTTP shape); and
somewhere to run the poller plus whatever agent backend you want as the mind.

```bash
git clone https://github.com/lancejames221b/muse-Jarvis.git
cd muse-Jarvis
npm ci
cp .env.example .env   # fill in tokens, guild/user/channel IDs
node src/index.js      # or the provided systemd user unit
```

Then point any poller at `/voice-inbox`, answer through `/speak`, and you
have a voice. Swap faster-whisper for any STT, Chatterbox for any TTS, the
agent backend for anything that can read a queue and write a reply. The
contract is three endpoints and a cursor.

## What we'd tell you before you start

- **Latency is honest.** Simple replies land in a couple of seconds; anything
  needing tools or thought takes ten to twenty. We say "on it" for the long
  ones rather than fake instant.
- **Gate it to one user first.** An open voice interface in a busy server is
  a different project. Ours trusts an allow-list.
- **Keep the queue boring.** The temptation is to make the protocol clever.
  Resist it. The boring queue is why the rewrite took an hour, not a week.

## A note on trust

The public repo carries no tokens, no user IDs, no infrastructure names —
everything personal is config, never code (`.env.example` is the contract,
and the git history has never contained a secret). Generalize first, publish
second, in that order.
