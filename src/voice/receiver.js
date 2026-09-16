/**
 * receiver.js — per-user Opus -> VAD-gated utterance -> wav -> STT -> router.
 *
 * Segmentation (ported from the old voice-receiver.js):
 *   - subscribe(userId, { end: AfterSilence, duration: VAD_TIMEOUT||1500 })
 *   - OpusDecoder (prism-media) -> PCM chunks
 *   - on stream end: drop if < 300ms of audio
 *   - savePcmAsWav -> stt.transcribe -> confidence gate -> router.route
 * Empty transcript -> silent drop. STT error -> logged drop. wav deleted.
 */
import { EndBehaviorType } from '@discordjs/voice';
import { createWriteStream } from 'node:fs';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpusDecoder } from './opus-decoder.js';
import logger from '../logger.js';

const MIN_AUDIO_DURATION_MS = 300;
const BARGE_IN_THRESHOLD_MS = 600;

const userSpeaking = new Map(); // userId -> { startTime }
const bargeInTimers = new Map();

export function clearSpeakingState() {
  for (const [, t] of bargeInTimers) clearTimeout(t);
  bargeInTimers.clear();
  // A mid-utterance rejoin leaves entries whose stream 'end' never fires —
  // without this the bot is permanently deaf to that user until restart.
  userSpeaking.clear();
}

function savePcmAsWav(pcmBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const sampleRate = 48000, numChannels = 1, bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    const ws = createWriteStream(outputPath);
    ws.write(header);
    ws.end(pcmBuffer);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

export function startReceiver({ connection, stt, router, player, allowedUsers, config }) {
  const receiver = connection.receiver;
  const silenceMs = config.vadTimeoutMs;
  const tmpDir = join(tmpdir(), 'jarvis-voice-rx');

  clearSpeakingState();

  receiver.speaking.on('start', (userId) => {
    if (!allowedUsers.includes(userId)) return;

    // Barge-in: owner speaking over Jarvis -> stop playback (600ms debounce).
    if (player.isSpeaking() && !bargeInTimers.has(userId)) {
      const timer = setTimeout(() => {
        bargeInTimers.delete(userId);
        if (player.isSpeaking()) {
          logger.info('receiver: barge-in — stopping playback');
          player.cancel();
        }
      }, BARGE_IN_THRESHOLD_MS);
      bargeInTimers.set(userId, timer);
    }

    if (userSpeaking.has(userId)) return; // already capturing
    userSpeaking.set(userId, { startTime: Date.now() });

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: silenceMs },
    });
    const decoder = new OpusDecoder();
    const chunks = [];
    audioStream.pipe(decoder);
    decoder.on('data', (c) => chunks.push(c));

    const cleanup = () => {
      userSpeaking.delete(userId);
      try { decoder.destroy(); } catch {}
    };
    audioStream.once('error', (err) => {
      logger.error(`receiver: audio stream error for ${userId}: ${err.message}`);
      cleanup();
    });
    decoder.once('error', () => {});

    audioStream.once('end', async () => {
      cleanup();
      const pcm = Buffer.concat(chunks);
      const durationMs = (pcm.length / (48000 * 2)) * 1000;
      if (durationMs < MIN_AUDIO_DURATION_MS) return;

      const wavPath = join(tmpDir, `utt_${userId}_${Date.now()}.wav`);
      try {
        await mkdir(tmpDir, { recursive: true });
        await savePcmAsWav(pcm, wavPath);
        let result = null;
        try {
          result = await stt.transcribe(wavPath);
        } catch (err) {
          logger.error(`receiver: STT failed for ${userId}: ${err.message}`);
          return;
        } finally {
          unlink(wavPath).catch(() => {});
        }
        if (!result) return; // empty transcript: silent drop
        if (result.confidence != null && result.confidence < config.borderlineConfidence) {
          logger.info(`receiver: low STT confidence (${result.confidence} < ${config.borderlineConfidence}) — dropped, not re-prompted`);
          return;
        }
        router.route(userId, result.text);
      } catch (err) {
        logger.error(`receiver: utterance handling failed for ${userId}: ${err.message}`);
      }
    });
  });

  receiver.speaking.on('end', (userId) => {
    if (bargeInTimers.has(userId)) {
      clearTimeout(bargeInTimers.get(userId));
      bargeInTimers.delete(userId);
    }
  });

  logger.info('receiver: listening');
}
