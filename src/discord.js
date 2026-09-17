/**
 * discord.js — Discord client: login, thread-silence guard, typed input,
 * text fallback, owner server-mute. In threads it stays completely silent.
 */
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import logger from './logger.js';
import { pushTextItem } from './voice/outbox.js';

export function createDiscord({ config }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      // Typed input needs these. MessageContent is privileged — enable it in
      // the Discord developer portal (Bot -> Privileged Gateway Intents),
      // or message.content arrives empty and typed input silently never queues.
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // DM channels arrive as partials
  });

  // Voice-only in threads: stay silent (ported from the old bot).
  client.on('messageCreate', (message) => {
    if (message.channel?.isThread?.()) return;
    handleTextInput(message).catch((err) => logger.warn(`discord: text input failed: ${err.message}`));
  });

  /**
   * Typed input from the owner. Accepted in: bot DMs, the main text channel,
   * and the owner's live voice channel chat. Elsewhere — silent. DMs and the
   * voice channel's chat are always addressed; in the main channel the
   * message must @-mention the bot or lead with "jarvis" (shared space).
   * Queued as { via: 'text', channelId }. Gated by TEXT_ENABLED.
   */
  async function handleTextInput(message) {
    if (!config.textEnabled) return;
    if (!message || message.author?.bot) return;
    if (!config.allowedUsers.includes(message.author.id)) return;
    const channel = message.channel;
    if (!channel) return;
    const isDM = !channel.guildId;
    let accepted = isDM;
    let isVoiceChat = false;
    if (!accepted && config.textChannelId && channel.id === config.textChannelId) accepted = true;
    if (!accepted) {
      const guild = client.guilds.cache.get(config.guildId);
      const member = guild?.members.cache.get(config.allowedUsers[0]);
      if (member?.voice?.channelId && channel.id === member.voice.channelId) {
        accepted = true;
        isVoiceChat = true;
      }
    }
    if (!accepted) return;
    const botId = client.user?.id;
    let text = message.content || '';
    let addressed = isDM || isVoiceChat;
    if (!addressed && botId) {
      const mentionRe = new RegExp(`<@!?${botId}>`);
      if (mentionRe.test(text)) {
        addressed = true;
        text = text.replace(mentionRe, ' ');
      }
    }
    if (!addressed && /^\s*(hey\s+)?jarvis[\s,.:;!?]+/i.test(text)) {
      addressed = true;
      text = text.replace(/^\s*(hey\s+)?jarvis[\s,.:;!?]+/i, '');
    }
    if (!addressed || !text.trim()) return;
    const item = pushTextItem(text.trim(), channel.id);
    if (item) logger.info(`discord: text input queued #${item.id} from #${channel.name || 'DM'}`);
  }

  /** Post a text reply to a specific channel (the /send-text path). */
  async function sendTextToChannel(channelId, text) {
    const body = String(text || '').substring(0, 2000);
    if (!body.trim()) return false;
    const ch = client.channels.cache.get(channelId)
      || await client.channels.fetch(channelId).catch(() => null);
    if (!ch?.isTextBased?.()) return false;
    await ch.send(body);
    logger.info(`discord: text reply sent to #${ch.name || channelId}`);
    return true;
  }

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

  return { client, login, postTextFallback, setOwnerServerMute, notify, sendTextToChannel };
}
