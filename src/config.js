/**
 * config.js — env parsing + fail-fast validation for jarvis-voice.
 *
 * Required: DISCORD_TOKEN, DISCORD_GUILD_ID, ALLOWED_USERS,
 *           ALERT_WEBHOOK_TOKEN, STT_URL, CHATTERBOX_URL.
 * Optional: DISCORD_VOICE_CHANNEL_ID / DISCORD_TEXT_CHANNEL_ID — honored only
 *           when they look like real Discord snowflakes. The live .env carries
 *           placeholders here; the bot then follows the owner's voice channel
 *           and DMs the owner for text fallback instead of failing to start.
 *
 * `node src/index.js --check-config` validates and exits 0/1 (used by tests).
 */
import 'dotenv/config';
import logger from './logger.js';

const _SNOWFLAKE_RE = /^\d{10,}$/;

function _num(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function _bool(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  return raw.toLowerCase() !== 'false';
}

export function loadConfig() {
  const errors = [];
  const warnings = [];

  const required = (name) => {
    const v = (process.env[name] || '').trim();
    if (!v) errors.push(`missing required env: ${name}`);
    return v;
  };

  const cfg = {
    discordToken: required('DISCORD_TOKEN'),
    guildId: required('DISCORD_GUILD_ID'),
    allowedUsers: required('ALLOWED_USERS').split(',').map((s) => s.trim()).filter(Boolean),
    webhookToken: required('ALERT_WEBHOOK_TOKEN'),
    sttUrl: required('STT_URL'),
    chatterboxUrl: required('CHATTERBOX_URL'),

    voiceChannelId: (process.env.DISCORD_VOICE_CHANNEL_ID || '').trim(),
    textChannelId: (process.env.DISCORD_TEXT_CHANNEL_ID || '').trim(),
    webhookPort: _num('ALERT_WEBHOOK_PORT', 3335),
    chatterboxFallbackUrl: (process.env.CHATTERBOX_FALLBACK_URL || '').trim(),
    chatterboxVoice: (process.env.CHATTERBOX_VOICE || 'jarvis').trim(),
    listenWindowMs: _num('JARVIS_LISTEN_WINDOW_MS', 30000),
    conversationModeEnabled: _bool('JARVIS_CONVERSATION_MODE_ENABLED', true),
    borderlineConfidence: _num('BORDERLINE_CONFIDENCE', 0.55),
    vadTimeoutMs: _num('VAD_TIMEOUT', 1500),
    utteranceDebounceMs: _num('UTTERANCE_DEBOUNCE_MS', 0),
  };

  if (!cfg.allowedUsers.length) errors.push('ALLOWED_USERS has no usable ids');
  if (cfg.voiceChannelId && !_SNOWFLAKE_RE.test(cfg.voiceChannelId)) {
    warnings.push(`DISCORD_VOICE_CHANNEL_ID is a placeholder ("${cfg.voiceChannelId}") — owner-follow mode`);
    cfg.voiceChannelId = '';
  }
  if (cfg.textChannelId && !_SNOWFLAKE_RE.test(cfg.textChannelId)) {
    warnings.push(`DISCORD_TEXT_CHANNEL_ID is a placeholder ("${cfg.textChannelId}") — text fallback goes to owner DM`);
    cfg.textChannelId = '';
  }

  return { cfg, errors, warnings };
}

/** Validate and print a report; returns true when valid. */
export function checkConfig() {
  const { cfg, errors, warnings } = loadConfig();
  for (const w of warnings) logger.warn(`config: ${w}`);
  if (errors.length) {
    for (const e of errors) logger.error(`config: ${e}`);
    return false;
  }
  logger.info('config: OK');
  logger.info(`config: guild=${cfg.guildId} owner=${cfg.allowedUsers[0]} port=${cfg.webhookPort}`);
  logger.info(`config: stt=${cfg.sttUrl}`);
  logger.info(`config: tts=${cfg.chatterboxUrl}${cfg.chatterboxFallbackUrl ? ' (fallback set)' : ' (no fallback)'}`);
  return true;
}
