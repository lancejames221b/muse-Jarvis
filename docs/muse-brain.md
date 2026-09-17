# The Muse brain

The reference brain for muse-Jarvis isn't a script — it's a persistent Muse
agent session. Your Muse *is* the mind: it polls the outbox, thinks, and
answers. One mind, dumb edges.

`examples/minimal-brain.py` is the portable stand-in (any OpenAI-compatible
endpoint, 80 lines, good for a smoke test). This doc is the real thing.

## The loop

Something must drain the outbox continuously — a small poller your Muse
supervises, or the agent itself working on a schedule. The logic:

1. `GET /voice-inbox?since=<cursor>&wait=45` with
   `Authorization: Bearer <ALERT_WEBHOOK_TOKEN>`. One poller owns the cursor;
   persist it in a file (e.g. `~/.jarvis-inbox-cursor`). Delivery is
   best-effort no-duplicate: the outbox is an in-memory ring that clears on
   bot restart.
2. For each item, decide: **answer now**, **work in the background**, or
   **stay silent**.
3. Reply with `POST /speak {"message": "..."}` — voice if the owner is in the
   channel, text fallback otherwise. For typed input (`via: "text"` with a
   `channelId`), reply with `POST /send-text {"channelId": "...", "message":
   "..."}` so the answer lands in the right channel. Text in, text out —
   typed messages never get voice playback.
4. Advance the cursor only after the item is handled. An un-advanced cursor
   is retried, never lost.

Item shape: `{id, ts, text, followUp?, via?, channelId?}`. `followUp: true`
means it's inside the ~30s conversation window opened by the wake phrase —
no need to re-verify addressing.

## Behavior rules

The rules that make it feel like Jarvis instead of a chatbot:

- **Silence by default.** The mic hears everything — conversations, calls,
  humming. Only clearly-addressed speech gets a response. When in doubt,
  nothing.
- **No instant acknowledgements.** Never reply just to confirm receipt.
- **"On it" is earned.** Say it only for work that genuinely takes a while —
  then go do the work in the background and report back.
- **Confirm destructive or irreversible actions** before doing them.
- **Keep a transcript ledger.** Append every exchange as `{ts, speaker,
  text}` to a local JSONL file; read the tail before answering. That's the
  conversation's memory across sessions — not any single session's context.
- **Long work goes to the background.** Anything over ~30 seconds should run
  async so the conversation loop keeps moving.

## The system prompt

The canonical, copy-paste-ready system prompt lives in
[jarvis-brain-prompt.md](./jarvis-brain-prompt.md). Paste it verbatim into a
persistent Muse session (or a scheduled task that stays alive), fill in the
two placeholders, and that session is the brain. The prompt is the whole
brain setup — the contract never changes: poll the queue, answer through
`/speak`.
