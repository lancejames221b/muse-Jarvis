/**
 * index.js — jarvis-voice boot. Wiring only, no logic.
 *
 *   config.check() -> discord login -> voice join -> receiver -> HTTP
 *
 * Dumb-pipe doctrine: this bot perceives (hear/transcribe/route) and actuates
 * (speak/TTS/Discord). ALL judgment lives in the Muse worker on the VM.
 */
import { checkConfig, loadConfig } from './config.js';
import logger from './logger.js';

if (process.argv.includes('--check-config')) {
  process.exit(checkConfig() ? 0 : 1);
}

const { cfg: config, errors } = loadConfig();
if (errors.length) {
  for (const e of errors) logger.error(`config: ${e}`);
  logger.error('config: refusing to start');
  process.exit(1);
}

const { createDiscord } = await import('./discord.js');
const { createVoiceConnection } = await import('./voice/connection.js');
const { createSTT } = await import('./voice/stt.js');
const { createTTS } = await import('./voice/tts.js');
const { createPlayer } = await import('./voice/player.js');
const { createRouter } = await import('./voice/router.js');
const { startReceiver, clearSpeakingState } = await import('./voice/receiver.js');
const { createHttp } = await import('./http.js');
const outbox = await import('./voice/outbox.js');
const { openMuseConversationWindow } = await import('./voice/muse-window.js');

const discord = createDiscord({ config });
const stt = createSTT(config);
const tts = createTTS(config);

let voiceConn; // set below; player closes over the getter
const player = createPlayer({
  tts,
  getConnection: () => voiceConn?.getConnection() || null,
  setOwnerServerMute: (m) => discord.setOwnerServerMute(m),
});

const router = createRouter({
  outbox,
  player,
  allowedUsers: config.allowedUsers,
  conversationModeEnabled: config.conversationModeEnabled,
  onHeard: (text, kind) => { postTranscriptFeed(text, kind); },
  getVoiceChannelId: () => voiceConn?.getChannelId?.() || null,
});

/**
 * Transcript ticker: every utterance the router accepts as addressed to
 * Jarvis is posted to the voice channel's text chat, so the owner can see
 * they're heard. Fire-and-forget — failures are logged, never thrown, so
 * the feed can never break the voice pipeline.
 */
async function postTranscriptFeed(text, kind) {
  try {
    if (!config.transcriptFeed) return;
    const channelId = voiceConn?.getChannelId?.() || null;
    if (!channelId) return;
    const client = discord?.client;
    if (!client) return;
    const ch = client.channels.cache.get(channelId)
      || await client.channels.fetch(channelId).catch(() => null);
    if (!ch || typeof ch.send !== 'function') return;
    const t = String(text || '').trim().slice(0, 400);
    if (!t) return;
    const msg = kind === 'bareWake' ? `🎙️ "${t}" — listening…` : `🎙️ "${t}"`;
    await ch.send(msg);
  } catch (err) {
    logger.warn(`transcript feed: ${err?.message || err}`);
  }
}

voiceConn = createVoiceConnection({
  client: discord.client,
  config,
  onJoined: {
    connected: (connection) => {
      clearSpeakingState();
      startReceiver({ connection, stt, router, player, allowedUsers: config.allowedUsers, config });
    },
    implicitWake: (userId) => openMuseConversationWindow(userId),
    notify: (text) => discord.notify(text),
  },
});

const http = createHttp({ config, player, voiceConn, discord, stt, tts, router });

process.on('SIGTERM', () => { logger.info('shutdown: SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { logger.info('shutdown: SIGINT'); process.exit(0); });

await discord.login();
voiceConn.watchOwner();
await voiceConn.start(); // null when the owner isn't in voice and no default — we wait
await http.listen();

logger.info('jarvis-voice: up — dumb pipe, Chatterbox only, no brain');
