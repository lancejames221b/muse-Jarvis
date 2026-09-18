/**
 * player.js — the ONE playback mechanism. Serialized FIFO.
 *
 * speak(text) -> 'voice' | 'text-fallback'
 *   1. wav = tts.synthesize(text); null -> 'text-fallback'
 *   2. server-mute the owner (prevents echo/feedback while Jarvis speaks)
 *   3. play wav into the voice connection via @discordjs/voice; await finish
 *   4. unmute. -> 'voice'
 * cancel(): stop playback now, drain queue, unmute. (barge-in / close phrases)
 * playTone('open'|'close'): short UI blip (wake-window open/close). Goes
 *   through the same FIFO so a tone can never cut off or talk over speech.
 *   No TTS, no server-mute (120ms soft blip; muting would be more disruptive
 *   than the blip). Fire-and-forget: never rejects.
 */
import { createAudioPlayer, createAudioResource, AudioPlayerStatus, entersState } from '@discordjs/voice';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import logger from '../logger.js';

const TONES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'tones');
const TONE_FILES = { open: 'window-open.wav', close: 'window-close.wav' };

export function createPlayer({ tts, getConnection, setOwnerServerMute }) {
  const queue = []; // { text, resolve } | { tone, resolve }
  let working = false;
  let current = null; // active AudioPlayer, if any

  async function pump() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        let result = 'text-fallback';
        try {
          result = await playOne(item);
        } catch (err) {
          logger.error(`player: playback failed: ${err.message}`);
        }
        try { await setOwnerServerMute(false); } catch {}
        item.resolve(result);
      }
    } finally {
      working = false;
    }
  }

  async function playOne(item) {
    if (item.tone) return playToneFile(item.tone);
    const text = item.text;
    const wav = await tts.synthesize(text);
    if (!wav) return 'text-fallback';

    const connection = getConnection();
    if (!connection || connection.state.status === 'destroyed') {
      logger.warn('player: no live voice connection — text fallback');
      return 'text-fallback';
    }

    await setOwnerServerMute(true);
    const player = createAudioPlayer();
    current = player;
    try {
      const resource = createAudioResource(wav);
      connection.subscribe(player);
      player.play(resource);
      await entersState(player, AudioPlayerStatus.Idle, 120_000);
      logger.info(`player: spoke "${text.substring(0, 60)}"`);
      return 'voice';
    } finally {
      current = null;
      try { player.stop(true); } catch {}
      try { await setOwnerServerMute(false); } catch {}
    }
  }

  /** Queue a speak; resolves 'voice' | 'text-fallback' when done. */
  function speak(text) {
    return new Promise((resolve) => {
      queue.push({ text, resolve });
      pump();
    });
  }

  /** Queue a UI tone ('open'|'close'); resolves when played. Never rejects. */
  function playTone(kind) {
    return new Promise((resolve) => {
      queue.push({ tone: kind, resolve });
      pump();
    });
  }

  async function playToneFile(kind) {
    const file = TONE_FILES[kind];
    if (!file) return 'tone-unknown';
    const full = path.join(TONES_DIR, file);
    if (!fs.existsSync(full)) {
      logger.warn(`player: tone file missing: ${full}`);
      return 'tone-missing';
    }
    const connection = getConnection();
    if (!connection || connection.state.status === 'destroyed') {
      return 'tone-no-connection';
    }
    const player = createAudioPlayer();
    current = player;
    try {
      const resource = createAudioResource(full);
      connection.subscribe(player);
      player.play(resource);
      await entersState(player, AudioPlayerStatus.Idle, 10_000);
      return 'tone';
    } catch (err) {
      logger.error(`player: tone playback failed: ${err.message}`);
      return 'tone-failed';
    } finally {
      current = null;
      try { player.stop(true); } catch {}
    }
  }

  /** Barge-in / close-phrase: stop now, drop the queue, unmute. */
  async function cancel() {
    queue.length = 0;
    if (current) {
      try { current.stop(true); } catch {}
    }
    try { await setOwnerServerMute(false); } catch {}
    logger.info('player: cancelled');
  }

  function isSpeaking() {
    return working;
  }

  function depth() {
    return queue.length + (working ? 1 : 0);
  }

  return { speak, playTone, cancel, isSpeaking, depth };
}
