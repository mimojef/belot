/**
 * Barrier coordinator — стартира се от run-phased-multi-table-load.ps1 преди k6.
 * Usage: node phased-load-coordinator.mjs <runId> <expectedTables> <port>
 *
 * Barrier логика:
 *  1. Login barrier  — освобождава се когато EXPECTED_TABLES маси докладват /login-ready
 *  2. WS barrier     — освобождава се когато EXPECTED_TABLES маси докладват /ws-ready
 *  /failure          — незабавно маркира съответния barrier като failed (всички polling VU-та
 *                      получават failed=true при следващ poll и затварят WS-ите си)
 */
import http from 'node:http';

const [runId, expectedTablesStr, portStr] = process.argv.slice(2);
const EXPECTED_TABLES = parseInt(expectedTablesStr, 10);
const PORT = parseInt(portStr, 10);

if (!runId || isNaN(EXPECTED_TABLES) || EXPECTED_TABLES < 1 || isNaN(PORT) || PORT < 1) {
  process.stderr.write(
    'Usage: node phased-load-coordinator.mjs <runId> <expectedTables> <port>\n',
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

// ── Barrier checks ─────────────────────────────────────────────────────────────

function checkLoginBarrier() {
  if (!loginBarrierReleased && !loginBarrierFailed && loginTablesReady.size === EXPECTED_TABLES) {
    loginBarrierReleased = true;
    console.log(
      `[coordinator] LOGIN BARRIER RELEASED: ${loginTablesReady.size}/${EXPECTED_TABLES} tables`,
    );
  }
}

function checkWsBarrier() {
  if (!wsBarrierReleased && !wsBarrierFailed && wsTablesReady.size === EXPECTED_TABLES) {
    wsBarrierReleased = true;
    console.log(
      `[coordinator] WS BARRIER RELEASED: ${wsTablesReady.size}/${EXPECTED_TABLES} tables`,
    );
  }
}

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

  // Health check — runId not required (runner polls this before k6 starts)
  if (path === '/health' && method === 'GET') {
    json(res, 200, {
      ok: true,
      runId,
      expectedTables: EXPECTED_TABLES,
      loginTablesReady: loginTablesReady.size,
      loginBarrierReleased,
      wsTablesReady: wsTablesReady.size,
      wsBarrierReleased,
    });
    return;
  }

  // All other endpoints require correct runId
  const reqRunId = url.searchParams.get('runId');
  if (reqRunId !== runId) {
    json(res, 400, { error: 'wrong or missing runId' });
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

  // POST /ws-unready removes stale readiness before the global barrier releases.
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

  // POST /failure   body: { phase: 'login'|'ws', tableIndex: number, playerIndex?: number, reason: string }
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

  // GET /status   — full state dump for monitoring
  if (path === '/status' && method === 'GET') {
    json(res, 200, {
      runId,
      expectedTables: EXPECTED_TABLES,
      loginTablesReady: loginTablesReady.size,
      loginBarrierReleased,
      loginBarrierFailed,
      loginFailureReason,
      wsTablesReady: wsTablesReady.size,
      wsBarrierReleased,
      wsBarrierFailed,
      wsFailureReason,
      failures,
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  // Print sentinel line — runner waits for /health, not this line
  console.log(
    `COORDINATOR_READY port=${PORT} runId=${runId} expectedTables=${EXPECTED_TABLES}`,
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
