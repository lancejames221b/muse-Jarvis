/**
 * router.js — THE ingress decision point. The only judgment in the bot.
 *
 * Wake regex -> conversation window -> hum filter -> outbox.push.
 * No isSideTalk: ambient/side-talk judgment belongs to the Muse worker
 * (dumb-pipe doctrine). Close phrases close the window + cancel playback.
 *
 * Heard-feedback: whenever the router accepts something addressed to Jarvis
 * (wake+command, follow-up, bare wake), it calls the optional onHeard(text,
 * kind) hook so the wiring layer can show a transcript ticker. The hook is
 * fire-and-forget and must never break routing.
 */
import {
  openMuseConversationWindow,
  closeMuseConversationWindow,
  isMuseConversationWindowOpen,
  isMuseConversationClosePhrase,
  isNonSpeechVocalization,
  onMuseWindowClose,
} from './muse-window.js';
import logger from '../logger.js';

const WAKE_RE = /^(hey[^a-z0-9]*)?jarvis\b[^a-z0-9]*/i;

export function createRouter({ outbox, player, allowedUsers, conversationModeEnabled, onHeard, getVoiceChannelId }) {
  // Wake-window tones (JARVIS_WINDOW_TONES_ENABLED=false to disable): a soft
  // blip when the window opens (fresh wake only, not follow-up refreshes) and
  // when it closes, so "it ignored me" vs "it didn't hear me" is never
  // ambiguous. Serialized through the player FIFO — a tone can never cut off
  // or talk over speech. Fire-and-forget; routing must never break because a
  // tone failed.
  const tonesEnabled = process.env.JARVIS_WINDOW_TONES_ENABLED !== 'false';
  function tone(kind) {
    if (!tonesEnabled) return;
    try { player.playTone(kind)?.catch?.(() => {}); } catch {}
  }
  onMuseWindowClose(() => tone('close'));
  // Voice-channel chat id for 'send it to the chat' requests: resolved lazily
  // at push time so reconnects and channel moves are picked up.
  const voiceChannelOpts = () => {
    const vch = getVoiceChannelId?.() || null;
    return vch ? { voiceChannelId: vch } : {};
  };
  function route(userId, text) {
    if (!allowedUsers.includes(userId)) return;
    const t = String(text || '').trim();
    if (!t) return;

    const m = t.match(WAKE_RE);
    if (m) {
      const cmd = t.slice(m[0].length).trim();
      if (isMuseConversationClosePhrase(cmd)) {
        player.cancel();
        closeMuseConversationWindow(userId);
        logger.info(`router: window closed by close phrase "${cmd.substring(0, 40)}"`);
        return;
      }
      if (cmd && isNonSpeechVocalization(cmd)) {
        // Hum after wake: drop, do NOT open the window.
        logger.info(`router: non-speech after wake ignored "${cmd.substring(0, 40)}"`);
        return;
      }
      if (conversationModeEnabled) {
        // Fresh open only: re-saying "jarvis" mid-window refreshes silently.
        if (!isMuseConversationWindowOpen(userId)) tone('open');
        openMuseConversationWindow(userId);
      }
      if (cmd) {
        const item = outbox.pushVoiceItem(cmd, voiceChannelOpts());
        if (item) {
          logger.info(`router: inbox #${item.id} "${cmd.substring(0, 60)}"`);
          try { onHeard?.(cmd, 'command'); } catch {}
        }
      } else {
        logger.info('router: bare wake — window opened, nothing pushed');
        try { onHeard?.(t, 'bareWake'); } catch {}
      }
      return;
    }

    if (conversationModeEnabled && isMuseConversationWindowOpen(userId)) {
      if (isMuseConversationClosePhrase(t)) {
        player.cancel();
        closeMuseConversationWindow(userId);
        logger.info(`router: window closed by close phrase "${t.substring(0, 40)}"`);
        return;
      }
      if (isNonSpeechVocalization(t)) {
        // In-window hum: drop, do NOT refresh the window.
        logger.info(`router: in-window non-speech ignored "${t.substring(0, 40)}"`);
        return;
      }
      const item = outbox.pushVoiceItem(t, { followUp: true, ...voiceChannelOpts() });
      if (item) {
        logger.info(`router: inbox #${item.id} (follow-up) "${t.substring(0, 60)}"`);
        openMuseConversationWindow(userId); // refresh on each follow-up
        try { onHeard?.(t, 'followUp'); } catch {}
      }
      return;
    }

    // Not addressed, no window: drop silently. The Muse worker judges ambient.
  }

  return { route, WAKE_RE };
}
