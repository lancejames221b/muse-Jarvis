# Dead Zeppelin

*Marvel-Jarvis capabilities on my own iron, secured by Tailscale — a personal
agentic AI system in the palm of my hand.*

Everybody's AI lives in somebody else's cloud. Mine lives on my own iron — the voice box in my house, the mind in a persistent Muse session.

It has a voice. It hears me through Discord, transcribes what I say, thinks
about it, and answers back out loud — in a cloned voice, into the voice
channel, while muting me so the mic doesn't echo. I talk to it from my phone,
from my laptop, from my desk. The capabilities feel endless. The reason that
isn't insane is the network.

This is the part nobody talks about: the balance between security and
capability. The industry's deal is simple — you get the capability, they get
your data, your audio, your everything, in their datacenter. Self-hosting
flips it — you keep everything, but historically you got weak models and duct
tape. I don't accept the trade anymore. The trick is Tailscale.

## The network is the security model

Every machine I own — the GPU box, the voice box, the Mac, the laptop — sits
on a private Tailscale network. Nothing I run listens on the public internet.
No port forwarding, no exposed dashboards, no "hope nobody finds port 7861."
My phone is on the same private network as my servers, so from the couch or
from across the country, my pocket has a direct encrypted line to my own
datacenter.

That's the whole model, and it's why this works: **capability without
exposure.** The agent can touch my machines, my files, my services — because
the network boundary is drawn around my stuff, not around a vendor's cloud.
Identity-based, encrypted wire to wire, and the internet at large can't even
see it.

## What "Jarvis" actually means here

Not a chatbot with a wake word. A system:

- **Ears and mouth, self-hosted.** A Discord bot joins my voice channel. It
  is deliberately dumb — no model, no tools, no opinions. It captures audio,
  ships it to a local speech-to-text service (faster-whisper on my own GPU),
  and plays back speech from a local TTS service (Chatterbox, cloned voice).
  Dumb pipes are reliable pipes.
- **One mind.** Every utterance the bot accepts goes into a dead-simple HTTP
  outbox — a queue with a cursor, Bearer auth, no-duplicate best-effort delivery.
  A tiny
  poller drains it. The *mind* is a persistent agent session running on Muse:
  it reads each item, decides whether to answer, work in the background, or
  stay silent, and sends replies back through the same pipe. All judgment in
  one place. The bot never decides anything, which means there's exactly one
  place to fix behavior.
- **Silence by default.** The mic hears everything — real conversations, phone
  calls, humming. Everything is treated as *not for the assistant* unless
  it's clearly addressed to it. Say the name once and it opens a short
  follow-up window; say "that's all" and it closes. A voice interface that
  interrupts is a surveillance device with manners.
- **Text shadow.** Typed messages — DMs, the main channel, the voice
  channel's chat — enter the same queue and get text replies. When I'm not in
  voice, spoken replies degrade to text that *follows me*: my live channel's
  chat first, then the main channel, then DM. A reply never gets lost.

And the part that makes it feel like the movies: the agent that designed and
built this system is the same one answering the calls. I built the voice box
with the voice that now lives in it.

## The honest trade-offs

Latency is honest — simple replies in a couple of seconds, real work in ten
to twenty. It says "on it" for the long ones instead of faking instant.

Self-hosting means I do my own ops: updates, keys, restarts, the 2 AM
"why is the tunnel down." That's the price of the capability, and Tailscale
makes it cheap — but not zero. Go in with your eyes open.

Start gated. Mine trusts an allow-list of one. An open voice interface in a
busy server is a different project.

## Replicate it

The recipe, generalized — no my-hostnames, no my-secrets, everything is
config:

1. **Tailscale first.** Put your machines and your phone on one tailnet. This
   is the foundation everything else stands on.
2. **Ears and mouth.** Clone `muse-Jarvis`, `cp .env.example .env`, fill in
   your Discord token and IDs, `npm ci`, run it. Any STT/TTS behind the
   documented HTTP shape works — the contract is `docs/speech-services.md`
   plus three endpoints and a cursor.
3. **A mind.** Point any poller at `/voice-inbox`, answer through `/speak`.
   The brain can be any agent loop you trust; mine runs on Muse.
4. **Keep the queue boring.** The temptation is to make the protocol clever.
   Resist it. The boring queue is why a full rewrite of the bot took an hour
   instead of a week — the agent side never noticed.

The repo carries no tokens, no IDs, no infrastructure names. Generalize
first, publish second, in that order.

---

The zeppelin was the biggest thing in the sky until somebody figured out how
to make it not explode. Personal AI had the same problem — all capability, no
safety. Turns out the fix was the network all along.
