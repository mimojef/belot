const COUNTERS = Object.freeze([
  'loginAttempts', 'loginSuccesses', 'loginFailures', 'wsAttempts', 'wsRetries',
  'wsOpens', 'currentActiveSockets', 'peakActiveSockets',
  'wsAttemptTimeouts', 'wsReadyProfiles', 'wsReadyTables',
  'peakReadyProfiles', 'peakReadyTables',
  'stableProfilesAtRelease', 'stableTablesAtRelease', 'wsPings',
  'wsPongs', 'wsTerminalFailures', 'terminalProfileFailures', 'holdFailures',
  'heartbeats', 'cleanupCompleted',
]);

export function validateTargetPair(baseUrl, wsUrl) {
  const base = strictUrl(baseUrl, 'BASE_URL');
  const socket = strictUrl(wsUrl, 'WS_URL');
  const allowedHosts = new Set(['185.203.117.14', '127.0.0.1', 'localhost']);
  const sameHost = base.hostname === socket.hostname;
  const valid = allowedHosts.has(base.hostname) && sameHost
    && base.protocol === 'http:' && socket.protocol === 'ws:'
    && base.port === '3101' && socket.port === '3101'
    && base.pathname === '/' && socket.pathname === '/ws';
  if (!valid) throw new Error('SAFETY: disallowed load-test target pair');
  return { baseUrl: base.origin, wsUrl: socket.href };
}

function strictUrl(value, name) {
  if (typeof value !== 'string' || value.trim() !== value || value === '') {
    throw new Error(`${name} must be a non-empty canonical URL`);
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} is invalid`); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, query, or fragment`);
  }
  return parsed;
}

export function sliceCredentials(credentials, start, count) {
  if (!Array.isArray(credentials) || !Number.isInteger(start) || start < 0
      || !Number.isInteger(count) || count < 0 || start + count > credentials.length) {
    throw new Error('Invalid credentials slice');
  }
  return credentials.slice(start, start + count).map((item, offset) => {
    if (!item || typeof item.email !== 'string' || item.email.trim() === ''
        || typeof item.password !== 'string' || item.password === '') {
      throw new Error(`Invalid credential at slice offset ${offset}`);
    }
    return { email: item.email, password: item.password };
  });
}

export function createMetrics() {
  return Object.fromEntries(COUNTERS.map((name) => [name, 0]));
}

export function incrementMetric(metrics, name, amount = 1) {
  if (!COUNTERS.includes(name) || !Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Invalid metric update');
  }
  metrics[name] = Math.min(Number.MAX_SAFE_INTEGER, metrics[name] + amount);
}

export function setMetric(metrics, name, value) {
  if (!COUNTERS.includes(name) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid metric value');
  }
  metrics[name] = value;
}

export function safeMetrics(metrics) {
  return Object.fromEntries(COUNTERS.map((name) => {
    const value = metrics?.[name];
    return [name, Number.isSafeInteger(value) && value >= 0 ? value : 0];
  }));
}

export function extractSessionCookie(headers) {
  const values = typeof headers?.getSetCookie === 'function'
    ? headers.getSetCookie() : splitSetCookie(headers?.get?.('set-cookie'));
  for (const value of values) {
    const match = /^\s*belot_session=([^;\s,]+)/i.exec(value);
    if (match && match[1]) return match[1];
  }
  throw new Error('Login did not return the required session cookie');
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]+)/);
}

export function absoluteDeadline(startedAtMs, durationMs) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Invalid absolute deadline');
  }
  return startedAtMs + durationMs;
}

export function readyTableIndexes(readyProfileIndexes, sliceLength) {
  const ready = new Set(readyProfileIndexes);
  const tables = [];
  for (let first = 0; first + 3 < sliceLength; first += 4) {
    if ([0, 1, 2, 3].every((offset) => ready.has(first + offset))) tables.push(first / 4);
  }
  return tables;
}
