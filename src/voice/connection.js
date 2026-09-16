/**
 * connection.js — join/reconnect the Discord voice channel.
 *
 * Channel resolution: the owner's live voice channel wins; otherwise
 * DISCORD_VOICE_CHANNEL_ID when it's a real snowflake. Follows the owner
 * across channels via voiceStateUpdate. Reconnects with backoff.
 */
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import logger from '../logger.js';

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

export function createVoiceConnection({ client, config, onJoined }) {
  const guildId = config.guildId;
  const ownerId = config.allowedUsers[0];
  let connection = null;
  let channelId = null;
  let reconnectAttempts = 0;
  let notified = false;

  function guild() {
    return client.guilds.cache.get(guildId);
  }

  function ownerVoiceChannelId() {
    try {
      return guild()?.members.cache.get(ownerId)?.voice?.channelId || null;
    } catch {
      return null;
    }
  }

  function targetChannelId() {
    return ownerVoiceChannelId() || config.voiceChannelId || null;
  }

  function isUserInVoice(userId) {
    try {
      return !!guild()?.members.cache.get(userId)?.voice?.channelId;
    } catch {
      return false;
    }
  }

  async function join(id) {
    const g = guild();
    if (!g) throw new Error(`guild ${guildId} not found`);
    let channel = g.channels.cache.get(id);
    if (!channel) {
      try { channel = await g.channels.fetch(id); } catch {}
    }
    if (!channel) throw new Error(`voice channel ${id} not found`);
    logger.info(`voice: joining ${channel.name} (${id})`);

    if (connection) {
      try { connection.destroy(); } catch {}
      connection = null;
    }

    connection = joinVoiceChannel({
      channelId: id,
      guildId,
      adapterCreator: g.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on('error', (err) => logger.error(`voice: connection error: ${err.message}`));

    let connectingCycles = 0;
    connection.on('stateChange', (oldState, newState) => {
      logger.info(`voice: ${oldState.status} -> ${newState.status}`);
      if (newState.status === VoiceConnectionStatus.Connecting) {
        connectingCycles++;
        if (connectingCycles > 10 && connection.state.status !== VoiceConnectionStatus.Destroyed) {
          logger.warn('voice: signalling oscillation — destroying for retry');
          try { connection.destroy(); } catch {}
        }
      } else if (newState.status === VoiceConnectionStatus.Ready) {
        connectingCycles = 0;
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      try { connection.destroy(); } catch {}
      connection = null;
      throw new Error(`voice join timed out (${err.message})`);
    }

    channelId = id;
    reconnectAttempts = 0;
    notified = false;

    // Implicit wake (2026-09-16 fix): if the owner is already here and unmuted,
    // open the conversation window — otherwise speech is silently dropped.
    try {
      const owner = channel.members?.get(ownerId);
      if (owner && !owner.voice.selfMute && !owner.voice.serverMute) {
        logger.info('voice: implicit wake — owner present and unmuted');
        onJoined?.implicitWake(ownerId);
      }
    } catch {}

    onJoined?.connected(connection);
    connection.once(VoiceConnectionStatus.Disconnected, handleDisconnect);
    return connection;
  }

  async function handleDisconnect() {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      reconnectAttempts = 0;
      connection.once(VoiceConnectionStatus.Disconnected, handleDisconnect);
      return;
    } catch {
      if (connection?.state.status !== VoiceConnectionStatus.Destroyed) {
        try { connection?.destroy(); } catch {}
      }
      connection = null;
      reconnectAttempts++;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
      logger.warn(`voice: disconnected (attempt #${reconnectAttempts}), rejoining in ${delay / 1000}s`);
      if (reconnectAttempts >= 5 && !notified) {
        notified = true;
        onJoined?.notify('Voice connection unstable — standing by, will keep retrying.');
      }
      const id = targetChannelId();
      setTimeout(() => {
        join(id || channelId).catch((err) => logger.error(`voice: rejoin failed: ${err.message}`));
      }, delay);
    }
  }

  /** Join now if there's a target; otherwise wait for the owner. */
  async function start() {
    const id = targetChannelId();
    if (!id) {
      logger.info('voice: no target channel (owner not in voice, no default) — waiting');
      return null;
    }
    return join(id);
  }

  /** Follow the owner when they move voice channels. */
  function watchOwner() {
    client.on('voiceStateUpdate', (oldState, newState) => {
      if (newState.id !== ownerId) return;
      const joined = newState.channelId;
      if (joined && joined !== channelId) {
        logger.info(`voice: owner moved to ${joined} — following`);
        join(joined).catch((err) => logger.error(`voice: follow failed: ${err.message}`));
      } else if (!joined) {
        logger.info('voice: owner left voice');
      } else if (joined && !connection) {
        join(joined).catch((err) => logger.error(`voice: join failed: ${err.message}`));
      }
    });
  }

  return {
    start,
    watchOwner,
    isUserInVoice,
    getConnection: () => connection,
    getChannelId: () => channelId,
  };
}
