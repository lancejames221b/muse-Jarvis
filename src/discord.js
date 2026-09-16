/**
 * discord.js — Discord client: login, thread-silence guard, text fallback,
 * owner server-mute. No conversational handling of typed messages — the bot
 * is voice-only; in threads it stays completely silent.
 */
import { Client, GatewayIntentBits } from 'discord.js';
import logger from './logger.js';

export function createDiscord({ config }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  // Voice-only in threads: stay silent (ported from the old bot).
  client.on('messageCreate', (message) => {
    if (message.channel?.isThread?.()) return;
    // Typed messages are not handled — voice only.
  });

  async function login() {
    await client.login(config.discordToken);
    await new Promise((resolve) => {
      if (client.isReady()) return resolve();
      client.once('ready', resolve);
    });
    logger.info(`discord: logged in as ${client.user.tag}`);
  }

  /**
   * Text fallback for /speak when the owner isn't in voice (or TTS failed).
   * Tracks the owner: his live voice channel's text chat first, then the
   * configured main channel (#general), then owner DM as last resort.
   */
  async function postTextFallback(text) {
    const body = String(text || '').substring(0, 2000);
    if (!body.trim()) return false;
    // 0. Owner's live voice channel text chat — follows him as he moves.
    try {
      const guild = client.guilds.cache.get(config.guildId);
      let member = guild?.members.cache.get(config.allowedUsers[0]);
      if (!member && guild) member = await guild.members.fetch(config.allowedUsers[0]).catch(() => null);
      const vcId = member?.voice?.channelId;
      const vc = vcId
        ? (client.channels.cache.get(vcId) || await client.channels.fetch(vcId).catch(() => null))
        : null;
      if (vc?.isTextBased?.()) {
        await vc.send(body);
        logger.info(`discord: text fallback posted to voice-channel chat #${vc.name}`);
        return true;
      }
    } catch (err) {
      logger.warn(`discord: voice-channel text post failed: ${err.message}`);
    }
    // 1. Configured main text channel (#general), when it's a real snowflake.
    if (config.textChannelId) {
      try {
        const ch = client.channels.cache.get(config.textChannelId)
          || await client.channels.fetch(config.textChannelId).catch(() => null);
        if (ch?.isTextBased?.()) {
          await ch.send(body);
          logger.info(`discord: text fallback posted to #${ch.name}`);
          return true;
        }
      } catch (err) {
        logger.warn(`discord: text channel post failed: ${err.message}`);
      }
    }
    // 2. DM the owner — always available, never a placeholder.
    try {
      const owner = await client.users.fetch(config.allowedUsers[0]);
      await owner.send(body);
      logger.info('discord: text fallback sent as owner DM');
      return true;
    } catch (err) {
      logger.error(`discord: text fallback failed: ${err.message}`);
      return false;
    }
  }

  /** Server-mute the owner while Jarvis speaks (echo/feedback prevention). */
  async function setOwnerServerMute(mute) {
    try {
      const guild = client.guilds.cache.get(config.guildId);
      const member = guild?.members.cache.get(config.allowedUsers[0]);
      if (!member?.voice?.channelId) return;
      if (member.voice.serverMute === mute) return;
      await member.voice.setMute(mute, mute ? 'Jarvis speaking' : 'Jarvis done speaking');
      logger.info(mute ? 'discord: owner server-muted (speaking)' : 'discord: owner server-unmuted');
    } catch (err) {
      logger.warn(`discord: server mute ${mute ? 'on' : 'off'} failed: ${err.message}`);
    }
  }

  function notify(text) {
    postTextFallback(text).catch(() => {});
  }

  return { client, login, postTextFallback, setOwnerServerMute, notify };
}
