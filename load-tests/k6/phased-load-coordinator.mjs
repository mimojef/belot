/**
 * Barrier coordinator — стартира се от run-phased-*-load.ps1 преди k6.
 * Usage: node phased-load-coordinator.mjs <runId> <expectedTables> <port> [token] [host] [heartbeatTimeoutSec]
 *
 * Barrier логика:
 *  1. Login barrier  — освобождава се когато EXPECTED_TABLES маси докладват /login-ready
 *  2. WS barrier     — освобождава се когато EXPECTED_TABLES маси докладват /ws-ready
 *  /failure          — маркира barrier като failed; всички VU-та получават failed=true
 *
 * Shard координация (distributed mode):
 *  /shard-register   — регистрира shard { shardId, tableOffset, tables }
 *  /shard-heartbeat  — обновява lastSeenAt; при липса → global failure след heartbeatTimeout
 *  /global-failure   — shard докладва crash → всички barrier-и failed, другите shardове спират
 *  /shard-complete   — shard докладва успешно завършване
 *
 * Auth (header-based):
 *  Всички endpoints освен /health изискват X-Belot-Load-Token header (ако token е зададен).
 *  Токенът НИКОГА не се очаква в URL query string.
 *
 * Binding safety:
 *  По подразбиране слуша само на 127.0.0.1 (loopback).
 *  Ако host != loopback, token е задължителен.
 *  За distributed тест: стартирай на VPS и достигай чрез SSH tunnel.
 */
import http from 'node:http';

const [runId, expectedTablesStr, portStr, token = '', host = '127.0.0.1', heartbeatTimeoutStr = '30'] = process.argv.slice(2);
const EXPECTED_TABLES = parseInt(expectedTablesStr, 10);
const PORT = parseInt(portStr, 10);
const TOKEN = token || '';
const HEARTBEAT_TIMEOUT_MS = Math.max(5, parseInt(heartbeatTimeoutStr, 10)) * 1000;

if (!runId || isNaN(EXPECTED_TABLES) || EXPECTED_TABLES < 1 || isNaN(PORT) || PORT < 1) {
  process.stderr.write(
    'Usage: node phased-load-coordinator.mjs <runId> <expectedTables> <port> [token] [host] [heartbeatTimeoutSec]\n',
  );
  process.exit(1);
}

const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
if (!isLoopback && !TOKEN) {
  process.stderr.write(
    `SAFETY: non-loopback bind (${host}) requires a non-empty token argument.\n`,
  );
  process.exit(1);
}
if (TOKEN && TOKEN.length < 32) {
  process.stderr.write(
    'SAFETY: token must be at least 32 characters. Use: openssl rand -hex 32\n',
  );
  process.exit(1);
}

// ── State ──────────────────────────────────────────────────────────────────────

const loginTablesReady = new Set();
const wsTablesReady = new Set();
const failures = [];

let loginBarrierReleased = false;
let loginBarrierFailed = false;
let loginFailureReason = null;

let wsBarrierReleased = false;
let wsBarrierFailed = false;
let wsFailureReason = null;

let globalFailure = null; // { shardId, reason } — first global failure; first writer wins

const shards = new Map(); // shardId → { shardId, tableOffset, tables, registeredAt, lastSeenAtMs, status }

// ── Auth (header-based) ────────────────────────────────────────────────────────

function tokenOk(req) {
  return !TOKEN || req.headers['x-belot-load-token'] === TOKEN;
}

// ── Global failure helper (first writer wins) ─────────────────────────────────

function recordGlobalFailure(fromShardId, reason) {
  if (globalFailure !== null) return;
  globalFailure = { shardId: fromShardId ?? null, reason };
  loginBarrierFailed = true;
  wsBarrierFailed = true;
  loginFailureReason = reason;
  wsFailureReason = reason;
  const sid = fromShardId ?? 'none';
  console.log(`[coordinator] GLOBAL FAILURE shard=${sid}: ${reason}`);
}

// ── Barrier checks ─────────────────────────────────────────────────────────────

function checkLoginBarrier() {
  if (!loginBarrierReleased && !loginBarrierFailed && loginTablesReady.size === EXPECTED_TABLES) {
    loginBarrierReleased = true;
    console.log(`[coordinator] LOGIN BARRIER RELEASED: ${loginTablesReady.size}/${EXPECTED_TABLES} tables`);
  }
}

function checkWsBarrier() {
  if (!wsBarrierReleased && !wsBarrierFailed && wsTablesReady.size === EXPECTED_TABLES) {
    wsBarrierReleased = true;
    console.log(`[coordinator] WS BARRIER RELEASED: ${wsTablesReady.size}/${EXPECTED_TABLES} tables`);
  }
}

// ── Heartbeat watchdog ─────────────────────────────────────────────────────────

const watchdogIntervalMs = Math.min(5000, Math.floor(HEARTBEAT_TIMEOUT_MS / 3));
const heartbeatWatchdog = setInterval(() => {
  const now = Date.now();
  for (const [, shard] of shards) {
    if (shard.status === 'online' && now - shard.lastSeenAtMs > HEARTBEAT_TIMEOUT_MS) {
      shard.status = 'stale';
      recordGlobalFailure(
        shard.shardId,
        `heartbeat timeout (>${Math.round(HEARTBEAT_TIMEOUT_MS / 1000)}s since last seen)`,
      );
    }
  }
}, watchdogIntervalMs);
heartbeatWatchdog.unref();

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const baseUrl = `http://127.0.0.1:${PORT}`;
  let url;
  try {
    url = new URL(req.url, baseUrl);
  } catch {
    json(res, 400, { error: 'invalid url' });
    return;
  }

  const path = url.pathname;
  const method = req.method;

  // /health — always open (runner polls before k6 starts, no auth required)
  if (path === '/health' && method === 'GET') {
    json(res, 200, {
      ok: true,
      runId,
      expectedTables: EXPECTED_TABLES,
      loginTablesReady: loginTablesReady.size,
      loginBarrierReleased,
      wsTablesReady: wsTablesReady.size,
      wsBarrierReleased,
      shardCount: shards.size,
    });
    return;
  }

  // All protected endpoints require correct runId
  if (url.searchParams.get('runId') !== runId) {
    json(res, 400, { error: 'wrong or missing runId' });
    return;
  }

  // Token auth — X-Belot-Load-Token header ONLY (never from URL)
  if (!tokenOk(req)) {
    json(res, 401, { error: 'invalid or missing token' });
    return;
  }

  // POST /shard-register   body: { shardId, tableOffset, tables }
  if (path === '/shard-register' && method === 'POST') {
    const raw = await readBody(req);
    let shardId, tableOffset, tables;
    try {
      const b = JSON.parse(raw);
      shardId = String(b.shardId || '');
      tableOffset = b.tableOffset;
      tables = b.tables;
      if (!shardId) throw new Error('shardId required');
      if (!Number.isInteger(tableOffset) || tableOffset < 0)
        throw new Error('tableOffset must be a non-negative integer');
      if (!Number.isInteger(tables) || tables < 1)
        throw new Error('tables must be a positive integer');
    } catch (e) {
      json(res, 400, { error: `invalid body: ${e.message}` });
      return;
    }
    if (tableOffset + tables > EXPECTED_TABLES) {
      json(res, 400, {
        error: `tableOffset(${tableOffset}) + tables(${tables}) = ${tableOffset + tables} exceeds expectedTables(${EXPECTED_TABLES})`,
      });
      return;
    }
    const existingShard = shards.get(shardId);
    if (existingShard) {
      if (existingShard.tableOffset === tableOffset && existingShard.tables === tables) {
        existingShard.lastSeenAtMs = Date.now();
        json(res, 200, { ok: true, idempotent: true });
        return;
      }
      json(res, 409, { error: `shardId '${shardId}' already registered with different params` });
      return;
    }
    for (const [existingId, s] of shards) {
      const newEnd = tableOffset + tables - 1;
      const existEnd = s.tableOffset + s.tables - 1;
      if (tableOffset <= existEnd && newEnd >= s.tableOffset) {
        json(res, 409, {
          error: `range [${tableOffset}..${newEnd}] overlaps with shard '${existingId}' [${s.tableOffset}..${existEnd}]`,
        });
        return;
      }
    }
    shards.set(shardId, {
      shardId,
      tableOffset,
      tables,
      registeredAt: Date.now(),
      lastSeenAtMs: Date.now(),
      status: 'online',
    });
    console.log(
      `[coordinator] shard-register shardId=${shardId} tableOffset=${tableOffset} tables=${tables}`,
    );
    json(res, 200, { ok: true });
    return;
  }

  // POST /shard-heartbeat   body: { shardId }
  if (path === '/shard-heartbeat' && method === 'POST') {
    const raw = await readBody(req);
    let shardId;
    try {
      shardId = String(JSON.parse(raw).shardId || '');
      if (!shardId) throw new Error('shardId required');
    } catch (e) {
      json(res, 400, { error: `invalid body: ${e.message}` });
      return;
    }
    const shard = shards.get(shardId);
    if (!shard) { json(res, 404, { error: 'unknown shardId' }); return; }
    if (shard.status === 'online' || shard.status === 'stale') {
      shard.status = 'online';
      shard.lastSeenAtMs = Date.now();
    }
    json(res, 200, {
      ok: true,
      globalFailed: loginBarrierFailed || wsBarrierFailed,
      globalFailure,
    });
    return;
  }

  // POST /global-failure   body: { shardId, reason }
  if (path === '/global-failure' && method === 'POST') {
    const raw = await readBody(req);
    let shardId, reason;
    try {
      const b = JSON.parse(raw);
      shardId = String(b.shardId || '');
      reason = String(b.reason || 'unknown');
    } catch (e) {
      json(res, 400, { error: `invalid body: ${e.message}` });
      return;
    }
    recordGlobalFailure(shardId, reason);
    json(res, 200, { ok: true, globalFailure });
    return;
  }

  // POST /shard-complete   body: { shardId }
  if (path === '/shard-complete' && method === 'POST') {
    const raw = await readBody(req);
    let shardId;
    try {
      shardId = String(JSON.parse(raw).shardId || '');
    } catch (e) {
      json(res, 400, { error: `invalid body: ${e.message}` });
      return;
    }
    const shard = shards.get(shardId);
    if (shard && shard.status === 'online') shard.status = 'completed';
    json(res, 200, { ok: true });
    return;
  }

  // POST /login-ready   body: { tableIndex: number }
  if (path === '/login-ready' && method === 'POST') {
    const raw = await readBody(req);
    let tableIndex;
    try {
      const body = JSON.parse(raw);
      tableIndex = body.tableIndex;
      if (!Number.isInteger(tableIndex) || tableIndex < 0 || tableIndex >= EXPECTED_TABLES)
        throw new Error(`tableIndex out of range 0..${EXPECTED_TABLES - 1}`);
    } catch (e) {
      json(res, 400, { error: `invalid body: ${e.message}` });
      return;
    }
    if (!loginBarrierFailed) {
      loginTablesReady.add(tableIndex);
      checkLoginBarrier();
      console.log(
        `[coordinator] login-ready table=${tableIndex} `
        + `(${loginTablesReady.size}/${EXPECTED_TABLES})`,
      );
    }
    json(res, 200, {
      ok: true,
      loginTablesReady: loginTablesReady.size,
      loginBarrierReleased,
      loginBarrierFailed,
    });
    return;
  }

  // GET /login-barrier
  if (path === '/login-barrier' && method === 'GET') {
    json(res, 200, {
      released: loginBarrierReleased,
      failed: loginBarrierFailed,
      failureReason: loginFailureReason,
      loginTablesReady: loginTablesReady.size,
      expectedTables: EXPECTED_TABLES,
    });
    return;
  }

  // POST /ws-ready   body: { tableIndex: number }
  if (path === '/ws-ready' && method === 'POST') {
    const raw = await readBody(req);
    let tableIndex;
    try {
      const body = JSON.parse(raw);
      tableIndex = body.tableIndex;
      if (!Number.isInteger(tableIndex) || tableIndex < 0 || tableIndex >= EXPECTED_TABLES)
        throw new Error(`tableIndex out of range 0..${EXPECTED_TABLES - 1}`);
    } catch (e) {
      json(res, 400, { error: `invalid body: ${e.message}` });
      return;
    }
    if (!wsBarrierFailed) {
      wsTablesReady.add(tableIndex);
      checkWsBarrier();
      console.log(
        `[coordinator] ws-ready table=${tableIndex} `
        + `(${wsTablesReady.size}/${EXPECTED_TABLES})`,
      );
    }
    json(res, 200, {
      ok: true,
      wsTablesReady: wsTablesReady.size,
      wsBarrierReleased,
      wsBarrierFailed,
    });
    return;
  }

  // POST /ws-unready   removes stale readiness before the global barrier releases
  if (path === '/ws-unready' && method === 'POST') {
    const raw = await readBody(req);
    let tableIndex;
    try {
      const body = JSON.parse(raw);
      tableIndex = body.tableIndex;
      if (!Number.isInteger(tableIndex) || tableIndex < 0 || tableIndex >= EXPECTED_TABLES)
        throw new Error(`tableIndex out of range 0..${EXPECTED_TABLES - 1}`);
    } catch (e) {
      json(res, 400, { error: `invalid body: ${e.message}` });
      return;
    }
    if (!wsBarrierReleased && !wsBarrierFailed) {
      wsTablesReady.delete(tableIndex);
      console.log(
        `[coordinator] ws-unready table=${tableIndex} `
        + `(${wsTablesReady.size}/${EXPECTED_TABLES})`,
      );
    }
    json(res, 200, {
      ok: true,
      wsTablesReady: wsTablesReady.size,
      wsBarrierReleased,
      wsBarrierFailed,
    });
    return;
  }

  // GET /ws-barrier
  if (path === '/ws-barrier' && method === 'GET') {
    json(res, 200, {
      released: wsBarrierReleased,
      failed: wsBarrierFailed,
      failureReason: wsFailureReason,
      wsTablesReady: wsTablesReady.size,
      expectedTables: EXPECTED_TABLES,
    });
    return;
  }

  // POST /failure   body: { phase: 'login'|'ws', tableIndex, playerIndex?, reason }
  if (path === '/failure' && method === 'POST') {
    const raw = await readBody(req);
    let phase, tableIndex, playerIndex, reason;
    try {
      const body = JSON.parse(raw);
      phase = String(body.phase || '');
      tableIndex = body.tableIndex;
      if (!Number.isInteger(tableIndex) || tableIndex < 0 || tableIndex >= EXPECTED_TABLES)
        throw new Error(`tableIndex out of range 0..${EXPECTED_TABLES - 1}`);
      playerIndex = Number.isInteger(body.playerIndex) ? body.playerIndex : null;
      if (playerIndex !== null && (playerIndex < 0 || playerIndex > 3))
        throw new Error('playerIndex out of range 0..3');
      reason = String(body.reason || 'unknown');
    } catch (e) {
      json(res, 400, { error: `invalid body: ${e.message}` });
      return;
    }
    failures.push({ phase, tableIndex, playerIndex, reason });
    if (phase === 'login' && !loginBarrierFailed) {
      loginBarrierFailed = true;
      loginFailureReason = reason;
      console.log(`[coordinator] LOGIN BARRIER FAILED table=${tableIndex}: ${reason}`);
    } else if (phase === 'ws' && !wsBarrierFailed) {
      wsBarrierFailed = true;
      wsFailureReason = reason;
      console.log(`[coordinator] WS BARRIER FAILED table=${tableIndex}: ${reason}`);
    }
    json(res, 200, { ok: true, totalFailures: failures.length });
    return;
  }

  // GET /status — full state dump for monitoring (shows each shard separately)
  if (path === '/status' && method === 'GET') {
    const shardList = [...shards.values()].map((s) => ({
      shardId: s.shardId,
      tableOffset: s.tableOffset,
      tables: s.tables,
      status: s.status,
      registeredAt: new Date(s.registeredAt).toISOString(),
      lastSeenAt: new Date(s.lastSeenAtMs).toISOString(),
      loginTablesReady: [...loginTablesReady]
        .filter((i) => i >= s.tableOffset && i < s.tableOffset + s.tables).length,
      wsTablesReady: [...wsTablesReady]
        .filter((i) => i >= s.tableOffset && i < s.tableOffset + s.tables).length,
    }));
    json(res, 200, {
      runId,
      expectedTables: EXPECTED_TABLES,
      globalFailure,
      loginTablesReady: loginTablesReady.size,
      loginBarrierReleased,
      loginBarrierFailed,
      loginFailureReason,
      wsTablesReady: wsTablesReady.size,
      wsBarrierReleased,
      wsBarrierFailed,
      wsFailureReason,
      failures,
      shards: shardList,
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, host, () => {
  console.log(
    `COORDINATOR_READY port=${PORT} runId=${runId} expectedTables=${EXPECTED_TABLES} host=${host}`,
  );
});

server.on('error', (err) => {
  process.stderr.write(`[coordinator] server error: ${err.message}\n`);
  process.exit(1);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
