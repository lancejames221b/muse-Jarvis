/**
 * http.js — wire protocol server (bare node:http, no express).
 *
 *   GET  /voice-inbox?since=<id>&wait=<secs>  long-poll, unchanged semantics
 *   POST /voice-inbox/test                    test hook (synthetic item)
 *   POST /speak {message, allow_text_post?}   Bearer; exact-hash dedup (60s);
 *                                             200ms in-flight mutex; voice or
 *                                             text fallback (skipped entirely
 *                                             when allow_text_post === false)
 *   POST /send-text {channelId, message}      Bearer; text reply into a channel;
 *                                             409 when TEXT_ENABLED=false
 *   GET  /health                               {ok, voice, outboxDepth, stt, tts}
 */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import logger from './logger.js';
import { getVoiceItems, waitForVoicePush, pushTestItem, inboxSize } from './voice/outbox.js';

const IN_FLIGHT_TTL_MS = 200;
const DEDUP_TTL_MS = 60_000;

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);
}

export function createHttp({ config, player, voiceConn, discord, stt, tts, router }) {
  const token = config.webhookToken;
  const inFlight = new Map(); // normKey -> ts
  const spokenHashes = new Map(); // sha256 -> ts

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function authorized(req) {
    const presented = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  function isInFlight(message) {
    const key = normKey(message);
    const now = Date.now();
    const last = inFlight.get(key);
    if (last && now - last < IN_FLIGHT_TTL_MS) return true;
    inFlight.set(key, now);
    if (inFlight.size > 50) {
      for (const [k, t] of inFlight) if (now - t > IN_FLIGHT_TTL_MS * 5) inFlight.delete(k);
    }
    return false;
  }

  function isDuplicate(message) {
    const h = createHash('sha256').update(normKey(message)).digest('hex');
    const now = Date.now();
    const last = spokenHashes.get(h);
    if (last && now - last < DEDUP_TTL_MS) return true;
    spokenHashes.set(h, now);
    if (spokenHashes.size > 200) {
      for (const [k, t] of spokenHashes) if (now - t > DEDUP_TTL_MS * 2) spokenHashes.delete(k);
    }
    return false;
  }

  async function handleVoiceInbox(req, res, url) {
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    let wait = parseInt(url.searchParams.get('wait'), 10);
    if (!Number.isInteger(wait) || wait < 1) wait = 0;
    else if (wait > 60) wait = 60; // clamp: an out-of-range wait used to hot-poll silently
    let items = getVoiceItems(since);
    if (items.length === 0 && wait > 0) {
      const waiter = waitForVoicePush(wait * 1000);
      items = getVoiceItems(since); // re-check after registering: closes the race
      if (items.length === 0) {
        const onClose = () => waiter.cancel();
        req.on('close', onClose);
        try {
          await waiter.promise;
        } finally {
          waiter.cancel();
          req.off('close', onClose);
        }
        items = getVoiceItems(since);
      } else {
        waiter.cancel();
      }
    }
    try {
      json(res, 200, { ok: true, items });
    } catch {} // client may have disconnected mid-poll
  }

  async function handleSpeak(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const message = body.message;
    if (!message || !String(message).trim()) {
      return json(res, 400, { error: 'message required' });
    }
    // "discord posts off" (2026-09-17): when false, speak in the voice
    // channel if the owner is there, but never post text to Discord —
    // no text fallback and no reply mirror.
    const allowTextPost = body.allow_text_post !== false;

    if (isInFlight(message)) {
      logger.info(`http: /speak in-flight dedup skip "${String(message).substring(0, 40)}"`);
      return json(res, 200, { ok: true, delivered: 'inflight-dedup-skip' });
    }
    if (isDuplicate(message)) {
      logger.info(`http: /speak hash dedup skip "${String(message).substring(0, 40)}"`);
      return json(res, 200, { ok: true, delivered: 'dedup-skip' });
    }

    const ownerId = config.allowedUsers[0];
    const userInVoice = voiceConn.isUserInVoice(ownerId);

    if (userInVoice) {
      logger.info(`http: /speak -> voice "${String(message).substring(0, 60)}"`);
      const delivered = await player.speak(String(message));
      if (delivered === 'voice') {
        // Refresh the conversation window so follow-ups skip the wake word.
        const { openMuseConversationWindow } = await import('./voice/muse-window.js');
        openMuseConversationWindow(ownerId);
        // Reply mirror: post the spoken reply as text in the voice channel's
        // chat, so there's a readable record in Discord. The transcript
        // ticker already posted the heard utterance; this is the other half.
        // Fire-and-forget — a mirror failure must never fail a successful
        // voice delivery. Text fallback already posts text, so it is
        // deliberately not mirrored again here (no duplicates).
        const channelId = voiceConn.getChannelId?.();
        if (allowTextPost && channelId) {
          discord.sendTextToChannel(channelId, `🔊 "${message}"`).catch((err) =>
            logger.warn(`http: reply mirror failed: ${err?.message || err}`));
        }
        return json(res, 200, { ok: true, delivered: 'voice', userInVoice: true });
      }
      logger.warn('http: /speak TTS failed — text fallback');
    } else {
      logger.info('http: /speak owner not in voice — text fallback');
    }
    if (!allowTextPost) {
      logger.info('http: /speak text post suppressed (allow_text_post=false)');
      return json(res, 200, { ok: true, delivered: 'suppressed', userInVoice });
    }
    await discord.postTextFallback(String(message));
    return json(res, 200, { ok: true, delivered: 'text-fallback', userInVoice });
  }

  async function handleSendText(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const message = body.message;
    const channelId = body.channelId;
    if (!config.textEnabled) {
      return json(res, 409, { error: 'text input disabled (TEXT_ENABLED=false)' });
    }
    if (!message || !String(message).trim()) {
      return json(res, 400, { error: 'message required' });
    }
    if (!channelId || !String(channelId).trim()) {
      return json(res, 400, { error: 'channelId required' });
    }
    const ok = await discord.sendTextToChannel(String(channelId).trim(), String(message));
    if (!ok) return json(res, 502, { error: 'send failed' });
    return json(res, 200, { ok: true, delivered: 'text', channelId: String(channelId).trim() });
  }

  function handleHealth(_req, res) {
    const conn = voiceConn.getConnection();
    json(res, 200, {
      ok: true,
      voice: !!conn && conn.state.status !== 'destroyed',
      outboxDepth: inboxSize(),
      playerDepth: player.depth(),
      stt: stt.getHealth(),
      tts: tts.getHealth(),
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return handleHealth(req, res);
      if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method === 'GET' && url.pathname === '/voice-inbox') return handleVoiceInbox(req, res, url);
      if (req.method === 'POST' && url.pathname === '/voice-inbox/test') {
        let body;
        try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: 'text required' });
        return json(res, 200, { ok: true, item: pushTestItem(text) });
      }
      if (req.method === 'POST' && url.pathname === '/speak') return handleSpeak(req, res);
      if (req.method === 'POST' && url.pathname === '/send-text') return handleSendText(req, res);
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      logger.error(`http: handler error: ${err.message}`);
      try { json(res, 500, { error: 'internal' }); } catch {}
    }
  });

  function listen() {
    const port = config.webhookPort;
    const host = process.env.HTTP_HOST || '127.0.0.1'; // loopback by default; set HTTP_HOST='::' to bind all interfaces (LAN-visible)
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        logger.info(`http: listening on [${host}]:${port}`);
        resolve();
      });
    });
  }

  return { listen, server };
}
