# Contributing

This is a personal project with a strong opinion: **the bot stays dumb**.
Issues and pull requests are welcome — here's what keeps them mergeable.

## The one rule

The bot hears, transcribes, queues, and speaks. It never decides anything.
If your change adds judgment, a model call, or a "smart" behavior to the bot
itself, it belongs in the brain, not here. Keep the pipe boring.

## Practical notes

- `node src/index.js --check-config` validates `.env` without connecting —
  run it before anything else.
- `npm ci` for installs; Node ≥ 24.
- Keep the three-endpoint contract (`/voice-inbox`, `/speak`, `/send-text`)
  backward compatible. The brain side can't be expected to track bot changes.
- No secrets in code, examples, or docs — not even "obviously fake" tokens.
  `.env` is gitignored; `.env.example` carries placeholders only.
- Match the existing code style: small modules, plain language in comments,
  fail-open toward silence (a voice interface that interrupts is a bug).

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, and the
relevant log lines. Redact tokens and IDs before pasting.
