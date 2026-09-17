/**
 * stt.js — faster-whisper HTTP client. Single path, no fallback.
 *
 * transcribe(wavPath) -> { text, confidence } | null
 *   - null: empty transcript (silence/hallucination — caller drops silently)
 *   - throws: HTTP error / timeout (caller drops + logs)
 *
 * Health: getHealth() -> 'ok' | 'down' based on the last attempt.
 */
import { readFile } from 'node:fs/promises';
import logger from '../logger.js';

const STT_TIMEOUT_MS = 60000;

export function createSTT(config) {
  const url = config.sttUrl;
  let lastOk = null; // null = never tried, true/false = last attempt

  async function transcribe(wavPath) {
    const buf = await readFile(wavPath);
    const form = new FormData();
    form.append('audio', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      });
    } catch (err) {
      lastOk = false;
      throw new Error(`STT request failed: ${err.message}`);
    }

    if (!res.ok) {
      lastOk = false;
      const body = await res.text().catch(() => '');
      throw new Error(`STT HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const data = await res.json().catch(() => ({}));
    const text = (data.text || '').trim();
    if (!text) {
      // Deterministic empty: same audio yields the same empty result.
      // No fallback, no retry — silence is dropped by the caller.
      logger.info('STT: empty transcript — dropped');
      return null;
    }

    lastOk = true;
    // Confidence gate input: only the service's own `confidence` (0..1).
    // avg_logprob is a negative log-probability — never compare it to the
    // 0..1 borderline threshold (kept for legacy compatibility).
    const rawConf = data.confidence;
    const confidence = typeof rawConf === 'number' && Number.isFinite(rawConf) ? rawConf : null;
    const confStr = confidence != null ? ` conf=${confidence}` : '';
    logger.info(`STT: "${text.substring(0, 80)}"${confStr}`);
    return { text, confidence };
  }

  function getHealth() {
    if (lastOk === null) return 'unknown';
    return lastOk ? 'ok' : 'down';
  }

  return { transcribe, getHealth };
}
