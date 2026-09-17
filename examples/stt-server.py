#!/usr/bin/env python3
"""Reference STT server implementing the docs/speech-services.md contract.

faster-whisper is a Python library, not a server — this is the small piece
that turns it into one.

Requires: pip install fastapi uvicorn faster-whisper
Run: uvicorn stt-server:app --host 127.0.0.1 --port 8765
Then: STT_URL=http://127.0.0.1:8765
"""
import io

from fastapi import FastAPI, File, UploadFile
from faster_whisper import WhisperModel

app = FastAPI()
# "base" is the speed/accuracy sweet spot; use "small" or "medium" if you
# have the GPU headroom. device="cpu" works, just slower.
model = WhisperModel("base", device="cuda", compute_type="float16")


@app.post("/")
async def transcribe(audio: UploadFile = File(...)):
    data = await audio.read()
    segments, _ = model.transcribe(io.BytesIO(data))
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text}
