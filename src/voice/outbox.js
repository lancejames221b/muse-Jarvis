/**
 * outbox.js — Outbox of [VOICE] transcriptions for the brain-side listener.
 *
 * POSITIVE MATCH ONLY: the bot pushes an item here at the true voice ingress —
 * handleSpeech (index.js) is invoked solely from the Discord voice-channel
 * receiver, and the push fires only for utterances addressed to me with the
 * "jarvis" wake phrase ("hey jarvis" kept as an accepted legacy variant;
 * wake phrase stripped, empty remainders skipped).
 * Marvel-style conversation mode: once "Jarvis" opens a follow-up window,
 * subsequent in-window utterances are pushed WITHOUT the wake word and carry
 * { followUp: true } so the brain-side listener can tell them apart.
 * The [VOICE] prompt tag is a separate downstream flag and is NOT the trigger.
 * Typed owner messages reach this module via pushTextItem() with
 * { via: 'text', channelId } — same outbox, same pipeline, answered in text.
 *
 * In-memory ring buffer (last 50), monotonic ids. Served by the alert-webhook
 * HTTP server at GET /voice-inbox?since=<id> (same Bearer auth as /speak).
 */

import { readFileSync, writeFileSync } from 'node:fs';

const MAX_ITEMS = 50;
const DEDUP_WINDOW_MS = 10000; // drop identical text pushed within 10s (retry-path safety)

// Monotonic ids must survive bot restarts: the brain's cursor is stored on
// its own side, so an id reset would make
// post-restart utterances invisible (id <= cursor). Persist the counter.
const NEXT_ID_FILE = new URL('../.voice-inbox-nextid', import.meta.url);
function loadNextId() {
  try {
    const n = parseInt(readFileSync(NEXT_ID_FILE, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch { return 1; }
}
function saveNextId(n) {
  try { writeFileSync(NEXT_ID_FILE, String(n), 'utf8'); } catch {}
}

let _nextId = loadNextId();
const _items = []; // oldest -> newest
let _lastPush = { text: '', at: 0 };

// -- Long-poll support ------------------------------------------------------
// Pending waiters woken by the next successful push. Each entry: { resolve, timer }.
// pushVoiceItem() wakes all waiters after appending; waiters re-check `since`
// and return. Entries are removed on wake, timeout, explicit cancel, or client
// disconnect, so nothing leaks. Pure notification - push ordering, ring-buffer
// eviction, and dedup behavior are unchanged.
const _waiters = new Set();
function _wakeWaiters() {
  if (_waiters.size === 0) return;
  for (const w of _waiters) {
    clearTimeout(w.timer);
    try { w.resolve(true); } catch {}
  }
  _waiters.clear();
}
/**
 * Register a one-shot waiter resolved `true` by the next successful push,
 * or `false` after `timeoutMs` with no push. Call `.cancel()` to unregister
 * early (client disconnect); cancel also resolves the promise `false` so a
 * hanging `await` never leaks.
 */
export function waitForVoicePush(timeoutMs) {
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const entry = { resolve: resolveFn, timer: null };
  entry.timer = setTimeout(() => {
    _waiters.delete(entry);
    try { resolveFn(false); } catch {}
  }, Math.max(1, timeoutMs | 0));
  if (entry.timer.unref) entry.timer.unref();
  _waiters.add(entry);
  return {
    promise,
    cancel() {
      if (_waiters.delete(entry)) {
        clearTimeout(entry.timer);
        try { resolveFn(false); } catch {}
      }
    },
  };
}

export function pushVoiceItem(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return null;
  const now = Date.now();
  if (t === _lastPush.text && now - _lastPush.at < DEDUP_WINDOW_MS) return null;
  _lastPush = { text: t, at: now };
  const item = { id: _nextId++, ts: new Date(now).toISOString(), text: t };
  if (opts.followUp) item.followUp = true;
  if (opts.via) item.via = opts.via;
  if (opts.channelId) item.channelId = opts.channelId;
  saveNextId(_nextId);
  _items.push(item);
  while (_items.length > MAX_ITEMS) _items.shift();
  _wakeWaiters(); // long-poll: hand the new item to any hanging GETs
  return item;
}

export function getVoiceItems(since = 0) {
  const s = Number(since) || 0;
  return _items.filter((i) => i.id > s);
}

// Test hook — inject a clearly-marked synthetic [VOICE] item. E2E testing only,
// never used in the production voice flow.
export function pushTestItem(text) {
  const item = pushVoiceItem('[TEST] ' + String(text || '').trim());
  if (item) item.test = true;
  return item;
}

/**
 * Typed input from the owner (Discord text). Same outbox, same pipeline —
 * the item carries { via: 'text', channelId } so the Muse side answers
 * in text, never voice. Text in, text out.
 */
export function pushTextItem(text, channelId) {
  return pushVoiceItem(String(text || '').trim(), { via: 'text', channelId });
}

export function inboxSize() {
  return _items.length;
}
