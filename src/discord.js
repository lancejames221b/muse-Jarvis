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

  // Threads MUSE opened after an @muse summon: threadId -> parentChannelId.
  // Messages inside them are implicitly addressed, so the conversation flows
  // without a mention on every line.
  const botThreads = new Map();

  /**
   * Typed input from allowed users. Accepted in every text channel the bot
   * can see — DMs, guild channels, and threads, except channels listed in
   * MUSE_SILENT_CHANNELS (an explicit @muse summon still opens a thread
   * there). Addressing: DMs, the owner's live voice-channel chat, and
   * MUSE's own summon threads are implicitly addressed; everywhere else the
   * message must @-mention the bot or lead with "jarvis" (shared space).
   * An @muse mention in a guild channel opens (or reuses) a thread and the
   * reply lands there, keeping the channel itself clean. Queued as
   * { via: 'text', channelId } so the reply lands in the exact originating
   * channel or thread. Gated by TEXT_ENABLED and the allowed-user list.
   * Text in, text out — never voice.
   */
  async function handleTextInput(message) {
    if (!config.textEnabled) return;
    if (!message || message.author?.bot) return;
    if (!config.allowedUsers.includes(message.author.id)) return;
    const channel = message.channel;
    if (!channel) return;
    const botId = client.user?.id;
    let text = message.content || '';
    const mentionRe = botId ? new RegExp(`<@!?${botId}>`) : null;
    const mentioned = !!(mentionRe && mentionRe.test(text));
    // Per-channel silence list: MUSE never answers typed input here —
    // unless explicitly summoned with @muse, which opens a thread instead.
    if (!mentioned && config.silentTextChannels.includes(channel.id)) return;
    const isDM = !channel.guildId;
    const inBotThread = channel.isThread?.() && botThreads.has(channel.id);
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
    let addressed = isDM || isVoiceChat || inBotThread;
    if (mentionRe && mentionRe.test(text)) {
      addressed = true;
      text = text.replace(mentionRe, ' ');
    }
    if (!addressed && /^\s*(hey\s+)?jarvis[\s,.:;!?]+/i.test(text)) {
      addressed = true;
      text = text.replace(/^\s*(hey\s+)?jarvis[\s,.:;!?]+/i, '');
    }
    if (!addressed || !text.trim()) return;

    // Explicit @muse summon in a guild channel: converse in a thread so the
    // channel itself stays clean. Reuse MUSE's live thread for the parent
    // channel when there is one; otherwise open a new one.
    let replyChannelId = channel.id;
    if (mentioned && !isDM && !channel.isThread?.()) {
      const thread = await getOrOpenSummonThread(message).catch((err) => {
        logger.warn(`discord: summon thread failed: ${err.message}`);
        return null;
      });
      if (thread) {
        replyChannelId = thread.id;
      } else if (config.silentTextChannels.includes(channel.id)) {
        return; // silent channel: no thread, no reply — stay silent.
      }
    }
    const item = pushTextItem(text.trim(), replyChannelId);
    if (item) logger.info(`discord: text input queued #${item.id} from #${channel.name || 'DM'}${replyChannelId !== channel.id ? ' (thread)' : ''}`);
  }

  /**
   * Thread MUSE chats in after an @muse summon. One live thread per parent
   * channel: reuse the tracked one (unarchiving if needed), else adopt an
   * existing live "MUSE chat" thread the bot owns, else open a new one.
   */
  async function getOrOpenSummonThread(message) {
    const parentId = message.channel.id;
    const clean = (message.content || '').replace(/<@!?\d+>/g, '').trim().slice(0, 40);
    const threadName = `MUSE chat${clean ? ' — ' + clean : ''}`.slice(0, 100);

    const useThread = async (t) => {
      if (t?.archived) await t.setArchived(false).catch(() => null);
      botThreads.set(t.id, parentId);
      return t;
    };

    const existingId = [...botThreads.entries()].find(([, p]) => p === parentId)?.[0];
    if (existingId) {
      const t = client.channels.cache.get(existingId)
        || await client.channels.fetch(existingId).catch(() => null);
      if (t?.isThread?.()) return useThread(t);
      botThreads.delete(existingId);
    }
    if (message.thread) return useThread(message.thread);
    try {
      const active = await message.channel.threads.fetchActive().catch(() => null);
      const owned = active?.threads?.find((t) => t.ownerId === client.user.id && t.name.startsWith('MUSE chat'));
      if (owned) return useThread(owned);
    } catch { /* fall through to creating */ }
    const thread = await message.startThread({ name: threadName, autoArchiveDuration: 1440 });
    botThreads.set(thread.id, parentId);
    logger.info(`discord: summon thread opened "${thread.name}" (${thread.id})`);
    return thread;
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
