/**
 * discord.js — Discord client: login, typed input, text fallback, owner
 * server-mute. Typed input works in every channel and thread the bot can see.
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

  // Typed input in every channel and thread the bot can see. Addressing
  // rules live in handleTextInput.
  client.on('messageCreate', (message) => {
    handleTextInput(message).catch((err) => logger.warn(`discord: text input failed: ${err.message}`));
  });

  /**
   * Typed input from allowed users. Accepted in every text channel the bot
   * can see — DMs, guild channels, and threads. Addressing: DMs and the
   * owner's live voice-channel chat are implicitly addressed; everywhere
   * else the message must @-mention the bot or lead with "jarvis" (shared
   * space). Queued as { via: 'text', channelId } so the reply lands in the
   * exact originating channel or thread. Gated by TEXT_ENABLED and the
   * allowed-user list. Text in, text out — never voice.
   */
  async function handleTextInput(message) {
    if (!config.textEnabled) return;
    if (!message || message.author?.bot) return;
    if (!config.allowedUsers.includes(message.author.id)) return;
    const channel = message.channel;
    if (!channel) return;
    const isDM = !channel.guildId;
    // The owner's live voice-channel chat is implicitly addressed — it
    // follows him as he moves channels.
    let isVoiceChat = false;
    if (!isDM) {
      const guild = client.guilds.cache.get(config.guildId);
      const member = guild?.members.cache.get(config.allowedUsers[0]);
      if (member?.voice?.channelId && channel.id === member.voice.channelId) {
        isVoiceChat = true;
      }
    }
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
