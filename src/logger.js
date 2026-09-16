/**
 * logger.js — minimal structured logger for jarvis-voice.
 * LOG_LEVEL env: debug | info | warn | error (default: info).
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const _level = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function _log(level, ...args) {
  if (LEVELS[level] < _level) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}]`;
  if (level === 'error') console.error(line, ...args);
  else console.log(line, ...args);
}

const logger = {
  debug: (...a) => _log('debug', ...a),
  info: (...a) => _log('info', ...a),
  warn: (...a) => _log('warn', ...a),
  error: (...a) => _log('error', ...a),
};

export default logger;
