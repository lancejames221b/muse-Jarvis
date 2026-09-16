/**
 * tts.js — Chatterbox TTS client only. No other providers.
 *
 * synthesize(text) -> wavPath | null
 *   POST {url}/tts {text, voice} -> WAV bytes. Tries CHATTERBOX_URL then
 *   CHATTERBOX_FALLBACK_URL (when set); null when both fail.
 *   Caller (player) degrades to text fallback on null.
 *
 * Health: getHealth() -> 'ok' | 'down' | 'unknown' from the last attempt.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import logger from '../logger.js';

const TTS_TIMEOUT_MS = 60000;
const MAX_CHARS = 600;

function sanitizeTextForTTS(text) {
  if (!text || typeof text !== 'string') return null;
  let cleaned = text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u00AD]/g, '')
    .trim();
  const textWithoutPunctuation = cleaned.replace(/[.,!?;:\-—…'"]/g, '').trim();
  if (textWithoutPunctuation.length === 0) return null; // punctuation-only
  cleaned = cleaned.replace(/\s+/g, ' ');
  // Sentence-safe truncate at MAX_CHARS (mirrors the VM `say` cap)
  if (cleaned.length > MAX_CHARS) {
    const cut = cleaned.slice(0, MAX_CHARS);
    const atSentence = cut.lastIndexOf('. ');
    const atSpace = cut.lastIndexOf(' ');
    cleaned = (atSentence > MAX_CHARS * 0.5 ? cut.slice(0, atSentence + 1) : cut.slice(0, atSpace > 0 ? atSpace : MAX_CHARS)).trim();
    if (!cleaned.endsWith('.')) cleaned += '.';
  }
  return cleaned;
}

export function createTTS(config) {
  const voice = config.chatterboxVoice;
  const urls = [config.chatterboxUrl, config.chatterboxFallbackUrl].filter(Boolean);
  const dir = join(tmpdir(), 'jarvis-voice-tts');
  let lastOk = null;

  async function synthesizeVia(url, text) {
    const res = await fetch(`${url}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 1000) throw new Error('suspiciously small WAV');
    await mkdir(dir, { recursive: true });
    const out = join(dir, `chatterbox_${Date.now()}.wav`);
    await writeFile(out, buffer);
    const latency = res.headers.get('X-Chatterbox-Latency-Ms') || '?';
    logger.info(`Chatterbox TTS: ${latency}ms (via ${url})`);
    return out;
  }

  async function synthesize(text) {
    const clean = sanitizeTextForTTS(text);
    if (!clean) {
      logger.info('TTS: empty/invalid text after sanitize — skipped');
      return null;
    }
    for (const url of urls) {
      try {
        const wav = await synthesizeVia(url, clean);
        lastOk = true;
        return wav;
      } catch (err) {
        logger.warn(`TTS unavailable at ${url}: ${err.message}`);
      }
    }
    lastOk = false;
    return null;
  }

  function getHealth() {
    if (lastOk === null) return 'unknown';
    return lastOk ? 'ok' : 'down';
  }

  return { synthesize, getHealth };
}
