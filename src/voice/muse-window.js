/**
 * muse-window.js — Marvel-style conversation window for the Muse voice pipeline.
 *
 * Say "Jarvis" once, then speak follow-ups naturally for ~30s without repeating
 * the wake word — Meta Ray-Ban glasses "respond without Hey Meta" behavior:
 * after each addressed request the mic stays open a short time, auto-closes
 * after silence, and "Stop"/"Cancel" ends it immediately.
 *
 * This is SEPARATE from the bot's own conversation window
 * (voice/wakeword.js: markBotResponse/lastBotResponseTime, CONVERSATION_WINDOW_MS).
 * That one gates the bot's local LLM brain; this one gates what gets pushed to
 * the Muse-side voice inbox (voice-inbox.js). The two windows are independent by
 * design: the bot's brain stands down for Muse-routed utterances.
 *
 * Env knobs:
 *   JARVIS_CONVERSATION_MODE_ENABLED — "false" disables follow-ups (default: true)
 *   JARVIS_LISTEN_WINDOW_MS          — follow-up window length in ms (default: 30000)
 */

import logger from '../logger.js';

/** Is Marvel-style conversation mode enabled? (default: true) */
export function isMuseConversationEnabled() {
  return process.env.JARVIS_CONVERSATION_MODE_ENABLED !== 'false';
}

/** Follow-up window length in ms. (default: 30000) */
export function museConversationWindowMs() {
  const n = parseInt(process.env.JARVIS_LISTEN_WINDOW_MS || '30000', 10);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

// userId -> window expiry timestamp (ms epoch). In-memory only: a bot restart
// simply closes any open window (fail-safe — worst case the user re-says "Jarvis").
const _museWindows = new Map();

// Prune expired entries periodically to prevent unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [userId, exp] of _museWindows) {
    if (now >= exp) _museWindows.delete(userId);
  }
}, 60 * 1000).unref?.();

/**
 * Open (or refresh) the follow-up window for a user, starting now.
 * Called on every wake-matched utterance — even a bare "Jarvis" whose empty
 * remainder is not pushed to the outbox.
 */
export function openMuseConversationWindow(userId) {
  if (!userId) return;
  _museWindows.set(userId, Date.now() + museConversationWindowMs());
  logger.info(`👂 Muse conversation window opened (${Math.round(museConversationWindowMs() / 1000)}s)`);
}

/** Force-close the follow-up window for a user. Returns true if one was open. */
export function closeMuseConversationWindow(userId) {
  if (userId && _museWindows.delete(userId)) {
    logger.info('🛑 Muse conversation window closed');
    return true;
  }
  return false;
}

/** Is the follow-up window currently open for this user? (lazy expiry) */
export function isMuseConversationWindowOpen(userId) {
  const exp = _museWindows.get(userId);
  if (!exp) return false;
  if (Date.now() >= exp) {
    _museWindows.delete(userId);
    return false;
  }
  return true;
}

// Explicit close phrases — end the window immediately and are NEVER pushed.
// Anchored to the whole utterance so "stop the music" / "cancel my alarm"
// still work as commands. Punctuation-stripped before matching, so
// "that's all" is tested as "thats all".
const MUSE_CLOSE_RE = /^(stop|cancel|never ?mind|thats all|that is all|thatll be all|that will be all|were done|im done|done|thank you|thanks|goodbye|bye|talk to you later|catch you later)\.?$/i;

/**
 * Is this utterance an explicit conversation-ender?
 * @param {string} text - transcript (wake phrase already stripped, if any)
 */
export function isMuseConversationClosePhrase(text) {
  const clean = String(text || '').toLowerCase().replace(/[.,!?']/g, '').trim();
  return MUSE_CLOSE_RE.test(clean);
}

// Tokens Whisper emits for humming, throat-clearing, and sung syllables.
// Whole-utterance match only — "hmm, what's the time" still passes through.
const NON_SPEECH_FILLER_TOKENS = new Set([
  'hmm', 'hm', 'mmm', 'mm', 'mmhmm', 'mmhm',
  'uh', 'uhh', 'uhhh', 'uhm', 'um', 'umm',
  'ah', 'ahh', 'ooh', 'oh', 'huh', 'erm', 'er', 'eh',
]);
// Scat syllables Whisper hallucinates out of melodies: "la la la", "dum dum".
const NON_SPEECH_HUM_SYLLABLES = new Set([
  'la', 'na', 'da', 'tra', 'dum', 'bum', 'dee', 'doo',
  'dah', 'tah', 'nah', 'lah', 'loo', 'lu', 'di', 'du', 'ba', 'pa',
]);

/**
 * Is this utterance a non-speech vocalization (humming, etc.)?
 *
 * The user hums; Whisper hallucinates words out of it ("hmm hmm", "[humming]",
 * "la la la"). With conversation mode live, an in-window hum would be
 * pushed as a phantom follow-up — spawning a worker and pointlessly
 * refreshing the window. Callers silently ignore these: never pushed to the
 * outbox, never (re)opens/refreshes the Muse window, never reaches the brain.
 *
 * ORDERING: close-phrase detection runs FIRST — "stop", "thanks",
 * "thank you", "done", "bye" must NEVER be classified as non-speech. This
 * function exempts close phrases defensively, but callers should still check
 * isMuseConversationClosePhrase before (or instead of) calling this.
 *
 * @param {string} text - transcript (wake phrase already stripped, if any)
 */
export function isNonSpeechVocalization(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  // 0. Close phrases are never non-speech — checked first, always.
  if (isMuseConversationClosePhrase(raw)) return false;
  // 1. Musical symbols anywhere → sung/hummed content ("♪ la la la").
  if (/[♪♫]/.test(raw)) return true;
  // 2. Strip bracketed STT tags ([humming], [music], [laughter], [silence],
  //    [inaudible], [applause], ...) and punctuation; if nothing meaningful
  //    remains, or every remaining token is filler/hum, it's non-speech.
  const stripped = raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[.,!?'"…\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!stripped) return true;
  const tokens = stripped.split(' ').filter(Boolean);
  return tokens.length > 0 &&
    tokens.every(t => NON_SPEECH_FILLER_TOKENS.has(t) || NON_SPEECH_HUM_SYLLABLES.has(t));
}
