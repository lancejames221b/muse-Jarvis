# Speech services

The bot does not bundle speech recognition or synthesis. It talks to two
services over HTTP, and they must implement these exact contracts.

## STT (speech to text)

`STT_URL` is used **verbatim** — no path is appended. `POST` to the URL itself:

```
POST {STT_URL}
Content-Type: multipart/form-data
  field:    "audio"
  filename: "audio.wav"
  mime:     "audio/wav"
→ 200 application/json  { "text": "..." }
```

`text` is the transcript, trimmed. An empty string means "no speech
detected" — the bot treats it as silence, not an error.

Reference implementation: `examples/stt-server.py` — a ~20-line FastAPI
server around faster-whisper. faster-whisper itself is a Python *library*,
not a server; that file is the missing piece between `pip install
faster-whisper` and a working `STT_URL`.

## TTS (text to speech)

`CHATTERBOX_URL` gets **`/tts` appended** — note the asymmetry with STT:

```
POST {CHATTERBOX_URL}/tts
Content-Type: application/json
  { "text": "...", "voice": "<CHATTERBOX_VOICE>" }
→ 200  raw WAV bytes
```

`voice` is the `CHATTERBOX_VOICE` value from your `.env` (a cloned-voice
identifier your TTS service understands). Responses under ~1KB are treated
as failures.

The reference TTS is Chatterbox behind a small HTTP wrapper exposing `/tts`
as above. Any TTS service that honours this shape works — the bot never
sees which one it is.
