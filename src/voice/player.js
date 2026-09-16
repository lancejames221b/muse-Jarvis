/**
 * player.js — the ONE playback mechanism. Serialized FIFO.
 *
 * speak(text) -> 'voice' | 'text-fallback'
 *   1. wav = tts.synthesize(text); null -> 'text-fallback'
 *   2. server-mute the owner (prevents echo/feedback while Jarvis speaks)
 *   3. play wav into the voice connection via @discordjs/voice; await finish
 *   4. unmute. -> 'voice'
 * cancel(): stop playback now, drain queue, unmute. (barge-in / close phrases)
 */
import { createAudioPlayer, createAudioResource, AudioPlayerStatus, entersState } from '@discordjs/voice';
import logger from '../logger.js';

export function createPlayer({ tts, getConnection, setOwnerServerMute }) {
  const queue = []; // { text, resolve }
  let working = false;
  let current = null; // active AudioPlayer, if any

  async function pump() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const { text, resolve } = queue.shift();
        let result = 'text-fallback';
        try {
          result = await playOne(text);
        } catch (err) {
          logger.error(`player: playback failed: ${err.message}`);
        }
        try { await setOwnerServerMute(false); } catch {}
        resolve(result);
      }
    } finally {
      working = false;
    }
  }

  async function playOne(text) {
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

  return { speak, cancel, isSpeaking, depth };
}
