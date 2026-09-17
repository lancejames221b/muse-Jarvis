#!/usr/bin/env python3
"""
minimal-brain.py — the simplest possible "mind" for muse-Jarvis.

Long-polls the bot's /voice-inbox, sends each utterance to any
OpenAI-compatible chat endpoint, and answers back:
  - spoken utterances -> POST /speak  (voice if you're in the channel,
    text fallback otherwise)
  - typed messages     -> POST /send-text (replies in the same channel)

Stdlib only. Not production-hardened — a starting point you can read in
one sitting, then replace with whatever agent loop you actually want.

Env:
  JARVIS_BOT_URL       bot base URL, e.g. http://your-server:3335
  JARVIS_WEBHOOK_TOKEN the ALERT_WEBHOOK_TOKEN from the bot's .env
  JARVIS_LLM_URL       OpenAI-compatible chat completions URL
  JARVIS_LLM_MODEL     model name
  JARVIS_LLM_KEY       Bearer key for the LLM endpoint (optional)
"""
import json
import os
import time
import urllib.request

BOT = os.environ.get("JARVIS_BOT_URL", "http://localhost:3335")
TOKEN = os.environ["JARVIS_WEBHOOK_TOKEN"]
LLM_URL = os.environ.get("JARVIS_LLM_URL", "http://localhost:1234/v1/chat/completions")
LLM_MODEL = os.environ.get("JARVIS_LLM_MODEL", "your-model")
LLM_KEY = os.environ.get("JARVIS_LLM_KEY", "")
CURSOR_FILE = os.path.expanduser("~/.jarvis-inbox-cursor")

SYSTEM = ("You are Jarvis, a concise voice assistant. "
          "Reply in one or two short sentences, plain text, no formatting.")


def bot(method, path, body=None):
    req = urllib.request.Request(
        BOT + path, method=method,
        headers={"Authorization": f"Bearer {TOKEN}",
                 "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=70) as r:
        return json.load(r)


def think(text):
    headers = {"Content-Type": "application/json"}
    if LLM_KEY:
        headers["Authorization"] = f"Bearer {LLM_KEY}"
    body = {"model": LLM_MODEL, "messages": [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": text}]}
    req = urllib.request.Request(LLM_URL, method="POST", headers=headers,
                                 data=json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["choices"][0]["message"]["content"].strip()


def main():
    cursor = 0
    if os.path.exists(CURSOR_FILE):
        cursor = int(open(CURSOR_FILE).read().strip() or 0)
    print(f"brain online, cursor={cursor}")
    while True:
        try:
            items = bot("GET", f"/voice-inbox?since={cursor}&wait=45")["items"]
        except Exception as e:  # bot down, network hiccup — just retry
            print("poll error:", e)
            time.sleep(5)
            continue
        for it in items:
            try:
                reply = think(it["text"])
                if it.get("via") == "text" and it.get("channelId"):
                    bot("POST", "/send-text",
                        {"channelId": it["channelId"], "message": reply})
                else:
                    bot("POST", "/speak", {"message": reply})
            except Exception as e:
                # Anything failed: stop here WITHOUT advancing the cursor,
                # so this item is retried on the next poll instead of lost.
                print(f"item {it.get('id')}: failed ({e}); will retry")
                break
            cursor = max(cursor, it["id"])
            open(CURSOR_FILE, "w").write(str(cursor))


if __name__ == "__main__":
    main()
