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
} from './muse-window.js';
import logger from '../logger.js';

const WAKE_RE = /^(hey[^a-z0-9]*)?jarvis\b[^a-z0-9]*/i;

export function createRouter({ outbox, player, allowedUsers, conversationModeEnabled, onHeard }) {
  function route(userId, text) {
    if (!allowedUsers.includes(userId)) return;
    const t = String(text || '').trim();
    if (!t) return;

    const m = t.match(WAKE_RE);
    if (m) {
      const cmd = t.slice(m[0].length).trim();
      if (isMuseConversationClosePhrase(cmd)) {
        closeMuseConversationWindow(userId);
        player.cancel();
        logger.info(`router: window closed by close phrase "${cmd.substring(0, 40)}"`);
        return;
      }
      if (cmd && isNonSpeechVocalization(cmd)) {
        // Hum after wake: drop, do NOT open the window.
        logger.info(`router: non-speech after wake ignored "${cmd.substring(0, 40)}"`);
        return;
      }
      if (conversationModeEnabled) openMuseConversationWindow(userId);
      if (cmd) {
        const item = outbox.pushVoiceItem(cmd);
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
        closeMuseConversationWindow(userId);
        player.cancel();
        logger.info(`router: window closed by close phrase "${t.substring(0, 40)}"`);
        return;
      }
      if (isNonSpeechVocalization(t)) {
        // In-window hum: drop, do NOT refresh the window.
        logger.info(`router: in-window non-speech ignored "${t.substring(0, 40)}"`);
        return;
      }
      const item = outbox.pushVoiceItem(t, { followUp: true });
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
